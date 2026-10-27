import { CalendarNotLoadedError } from '@broker/calendar';
import { decide, type Disposition } from '../domain/acceptance.js';
import type { BudgetLevel } from '../domain/budget.js';
import { isIndex, quoteWarnings, type ExternalQuote } from '../domain/quote.js';
import { insideWindow, isStale, quoteWindow } from '../domain/schedule.js';
import { raiseAlert, type MarketDataDeps } from './context.js';
import type { MarketDataTx, StoredQuote } from './ports.js';
import type { ProviderResult, RawResponse } from './provider.js';

export interface IngestResult {
  disposition: Disposition;
  quote: ExternalQuote;
  /** A leitura aceita (ou a vigente, se esta não foi aceita). */
  current: StoredQuote | null;
}

export interface QuotesHooks {
  /** Leitura aceita, depois do commit: o preço de referência desliza para o novo valor. */
  onAccepted?: (q: StoredQuote) => Promise<void>;
  /** A fonte devolveu outro ticker (`changed = true`): resolver a renomeação (RN-INS-033). */
  onSymbolChanged?: (requestedSymbol: string) => void;
}

export const quoteCacheKey = (symbol: string) => `quote:${symbol}`;

/** Corpo do evento `market_data.external_quote_received` (sem nomes da brapi, RN-BRP-002). */
export function quotePayload(q: StoredQuote): Record<string, unknown> {
  const x = q.quote;
  return {
    instrumentId: q.instrumentId,
    symbol: q.symbol,
    sourceSymbol: x.symbol,
    kind: q.kind,
    lastPrice: x.lastPrice,
    quoteTime: x.quoteTime.toString(),
    open: x.open,
    high: x.high,
    low: x.low,
    previousClose: x.previousClose,
    change: x.change,
    changePercent: x.changePercent,
    volume: x.volume,
    marketCap: x.marketCap,
    week52Low: x.week52Low,
    week52High: x.week52High,
    currency: x.currency,
    stale: q.stale,
    source: q.provider,
    fetchedAt: q.fetchedAt.toString(),
  };
}

/**
 * Leituras de cotação (Brapi §7, §9): normaliza, grava `external_quote_history` com o hash do corpo
 * bruto, descarta as fora de ordem (RN-BRP-072), põe saltos em quarentena (RN-BRP-071), guarda a
 * última aceita em `external_quote`, no Valkey e o corpo bruto no MinIO (RN-BRP-061), e publica
 * `market_data.external_quote_received`. Uma falha nunca apaga a última cotação válida (RN-BRP-081).
 */
export class Quotes {
  private readonly deprecationAlerted = new Set<string>();

  constructor(
    private readonly d: MarketDataDeps,
    private readonly budgetLevel: () => BudgetLevel,
    private readonly hooks: QuotesHooks = {},
  ) {}

  /** `symbol` é o ticker pedido (o nosso); a fonte pode responder com outro (`changed`). */
  async ingest(result: ProviderResult<ExternalQuote>): Promise<IngestResult> {
    const { value: quote, raw } = result;
    const key = quote.requestedSymbol;
    await this.saveRaw(key, raw);
    const out = await this.d.store.transaction(async (tx) => {
      const instrument = isIndex(key) ? null : await tx.instrumentBySymbol(key);
      const last = await tx.quote(key, { forUpdate: true });
      const quarantined = await tx.quarantine(key);
      const known = instrument
        ? await this.d.corporateActions.knownActionOn(
            instrument.instrumentId,
            quote.quoteTime.businessDate(),
          )
        : false;
      const decision = decide({
        last: last ? { price: last.quote.lastPrice, quoteTime: last.quote.quoteTime } : null,
        quarantined,
        reading: { price: quote.lastPrice, quoteTime: quote.quoteTime },
        jumpAlertPct: this.d.plan.jumpAlertPct,
        corporateActionKnown: known,
      });
      const warnings = quoteWarnings(quote, instrument?.tickSize);
      if (warnings.length)
        this.d.logger.warn(
          { event: 'market_data.quote_warnings', symbol: key, warnings },
          'cotação com avisos de consistência',
        );
      await tx.insertHistory({
        id: this.d.newId(),
        symbol: key,
        instrumentId: instrument?.instrumentId ?? null,
        provider: this.d.provider.name,
        fetchedAt: raw.receivedAt,
        quoteTime: quote.quoteTime,
        quote,
        rawSha256: raw.sha256,
        disposition: decision.disposition,
        warnings,
      });
      await this.deprecation(tx, raw);
      if (decision.clearQuarantine) await tx.clearQuarantine(key);

      if (decision.disposition === 'ACCEPTED') {
        const stored: StoredQuote = {
          symbol: key,
          instrumentId: instrument?.instrumentId ?? null,
          kind: isIndex(key) ? 'INDEX' : 'INSTRUMENT',
          quote,
          fetchedAt: raw.receivedAt,
          provider: this.d.provider.name,
          rawSha256: raw.sha256,
          stale: false,
          staleSince: null,
        };
        await tx.saveQuote(stored);
        await tx.publish(
          { type: 'market_data.external_quote_received', payload: quotePayload(stored) },
          stored.instrumentId ?? key,
        );
        if (decision.releasedFromQuarantine)
          await raiseAlert(
            this.d,
            tx,
            'QUOTE_QUARANTINED',
            'INFO',
            `${key}: salto confirmado pela leitura seguinte, novo preço liberado`,
            {
              symbol: key,
              price: quote.lastPrice,
              jumpPct: decision.jumpPct,
            },
          );
        return { decision, current: stored };
      }
      if (decision.disposition === 'QUARANTINED') {
        await tx.saveQuarantine({
          symbol: key,
          price: quote.lastPrice,
          quoteTime: quote.quoteTime,
          since: this.d.clock.now(),
          jumpPct: decision.jumpPct!,
        });
        await raiseAlert(
          this.d,
          tx,
          'QUOTE_QUARANTINED',
          'WARNING',
          `${key}: leitura com salto de ${(Number(decision.jumpPct) * 100).toFixed(2)}% em quarentena`,
          {
            symbol: key,
            price: quote.lastPrice,
            anchor: last?.quote.lastPrice ?? null,
            quoteTime: quote.quoteTime.toString(),
          },
        );
      }
      if (decision.disposition === 'DISCARDED_OUT_OF_ORDER')
        this.d.logger.info(
          {
            event: 'market_data.quote_discarded',
            symbol: key,
            quoteTime: quote.quoteTime.toString(),
          },
          'leitura fora de ordem descartada',
        );
      return { decision, current: last };
    });

    if (out.current) {
      await this.d.cache
        .set(
          quoteCacheKey(key),
          serializeQuote(out.current),
          this.d.clock.now(),
          this.d.plan.updateIntervalMs,
        )
        .catch((err: unknown) =>
          this.d.logger.warn({ event: 'market_data.cache_failed', err }, 'falha ao gravar o cache'),
        );
    }
    if (out.decision.disposition === 'ACCEPTED' && out.current)
      await this.hooks.onAccepted?.(out.current);
    if (quote.changed) this.hooks.onSymbolChanged?.(key);
    return { disposition: out.decision.disposition, quote, current: out.current };
  }

  /**
   * Defasagem (RN-BRP-070): durante o pregão, marca quem passou de `update_interval + 15 min` e
   * publica `market_data.instrument_stale` uma vez por episódio. Em `EXHAUSTED`, todos os preços
   * ficam defasados (Brapi §5.3). A cotação continua valendo (RN-BRP-081).
   */
  async checkStale(): Promise<number> {
    const now = this.d.clock.now();
    let window: ReturnType<typeof quoteWindow>;
    try {
      window = quoteWindow(this.d.calendar.sessionSchedule(now.businessDate()));
    } catch (err) {
      if (err instanceof CalendarNotLoadedError) return 0;
      throw err;
    }
    const inSession = insideWindow(window, now);
    if (!inSession) return 0;
    const exhausted = this.budgetLevel() === 'EXHAUSTED';
    return this.d.store.transaction(async (tx) => {
      let n = 0;
      for (const q of await tx.quotes()) {
        if (q.stale) continue;
        const stale =
          exhausted ||
          isStale({
            now,
            quoteTime: q.quote.quoteTime,
            updateIntervalMs: this.d.plan.updateIntervalMs,
            inSession,
            sessionStart: window!.from,
          });
        if (!stale) continue;
        await tx.markStale(q.symbol, q.quote.quoteTime);
        if (q.instrumentId) {
          await tx.publish(
            {
              type: 'market_data.instrument_stale',
              payload: { instrumentId: q.instrumentId, staleSince: q.quote.quoteTime.toString() },
            },
            q.instrumentId,
          );
        }
        n++;
      }
      return n;
    });
  }

  private async saveRaw(symbol: string, raw: RawResponse): Promise<void> {
    if (!raw.url.startsWith('http')) return;
    const key = `${raw.receivedAt.businessDate().toString()}/${encodeURIComponent(symbol)}/${raw.sha256}.json`;
    await this.d.raw
      .put(key, raw.body)
      .catch((err: unknown) =>
        this.d.logger.warn(
          { event: 'market_data.raw_store_failed', err },
          'falha ao gravar o corpo bruto',
        ),
      );
  }

  private async deprecation(tx: MarketDataTx, raw: RawResponse): Promise<void> {
    if (!raw.deprecation) return;
    const key = `${raw.endpoint}|${raw.receivedAt.businessDate().toString()}`;
    if (this.deprecationAlerted.has(key)) return;
    this.deprecationAlerted.add(key);
    await raiseAlert(
      this.d,
      tx,
      'DEPRECATION',
      'WARNING',
      `${raw.endpoint}: rota marcada como descontinuada pela brapi`,
      {
        endpoint: raw.endpoint,
        sunset: raw.deprecation.sunset,
        link: raw.deprecation.link,
      },
    );
  }
}

/** Forma do cache: a cotação com os instantes em texto. */
export function serializeQuote(q: StoredQuote): Record<string, unknown> {
  return {
    ...q,
    quote: { ...q.quote, quoteTime: q.quote.quoteTime.toString() },
    fetchedAt: q.fetchedAt.toString(),
    staleSince: q.staleSince?.toString() ?? null,
  };
}
