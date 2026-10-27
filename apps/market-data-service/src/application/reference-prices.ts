import { CalendarNotLoadedError } from '@broker/calendar';
import { BusinessDate, Decimal, Instant } from '@broker/domain-kernel';
import {
  ReferencePriceModel,
  referenceSeed,
  sigmaPerTick,
  type ContinuousWindow,
  type ManualOverride,
  type ReferenceUpdate,
} from '../domain/reference-price.js';
import { MarketDataError, type MarketDataDeps } from './context.js';
import type { InstrumentRef, MarketDataTx, StoredQuote } from './ports.js';

/** Dias de fechamentos para a volatilidade do ruído (Brapi §8.2: E3, até 3 meses). */
const VOLATILITY_DAYS = 60;
/** Atraso máximo publicado ao alcançar o tempo do ambiente (o resto só evolui o estado). */
const CATCH_UP_MS = 60_000;

export interface ReferenceView {
  instrumentId: string;
  price: string | null;
  origin: string | null;
  anchorPrice: string;
  externalQuoteTime: string | null;
  seq: number;
  tradingDate: string;
  noiseEnabled: boolean;
}

/**
 * Preço de referência por instrumento do universo (Brapi §8, RN-SYN-001..004/006): o modelo é o do
 * domínio; aqui ele é carregado, avançado no tempo do ambiente, gravado (`reference_price_state`)
 * e cada valor vira `market_data.reference_price_updated` com `origin`, na mesma transação.
 */
export class ReferencePrices {
  constructor(private readonly d: MarketDataDeps) {}

  /** Uma rodada: avança todos os instrumentos do universo até agora. */
  async tick(): Promise<number> {
    const instruments = await this.d.store.transaction((tx) => tx.tradableInstruments());
    let n = 0;
    for (const i of instruments) n += await this.advance(i.instrumentId);
    return n;
  }

  async advance(instrumentId: string): Promise<number> {
    const now = this.d.clock.now();
    return this.d.store.transaction(async (tx) => {
      const loaded = await this.load(tx, instrumentId, now);
      if (!loaded) return 0;
      const updates = loaded.model.advance(now, await this.overrides(tx, instrumentId, now), {
        emitFrom: this.emitFrom(now),
      });
      if (updates.length === 0 && !loaded.fresh) return 0;
      await this.persist(tx, loaded.model, updates);
      return updates.length;
    });
  }

  /** Leitura aceita (`market_data.external_quote_received`): nova âncora, com glide no contínuo. */
  async onAccepted(q: StoredQuote): Promise<void> {
    if (!q.instrumentId) return;
    const now = this.d.clock.now();
    await this.d.store.transaction(async (tx) => {
      const instrument = await tx.instrument(q.instrumentId!);
      if (!instrument?.tradable) return;
      const loaded = await this.load(tx, q.instrumentId!, now, q.quote.lastPrice);
      if (!loaded) return;
      const overrides = await this.overrides(tx, q.instrumentId!, now);
      const updates = loaded.model.onAnchor(
        q.quote.lastPrice,
        q.quote.quoteTime.toString(),
        now,
        overrides,
        { emitFrom: this.emitFrom(now) },
      );
      await this.persist(tx, loaded.model, updates);
    });
  }

  /** RN-SYN-006: fixa a referência por um período (`origin = MANUAL`). */
  async override(input: {
    instrumentId: string;
    price: string;
    minutes: number;
    reason: string;
    by: string;
  }) {
    const price = new Decimal(input.price);
    if (!price.gt(0))
      throw new MarketDataError(422, 'INVALID_PRICE', 'O preço precisa ser positivo.');
    const now = this.d.clock.now();
    const row = {
      id: this.d.newId(),
      instrumentId: input.instrumentId,
      price: price.toFixed(4),
      validFrom: now,
      validUntil: now.plusMillis(input.minutes * 60_000),
      createdBy: input.by,
      reason: input.reason,
      createdAt: now,
    };
    await this.d.store.transaction(async (tx) => {
      const i = await tx.instrument(input.instrumentId);
      if (!i) throw new MarketDataError(404, 'INSTRUMENT_NOT_FOUND', 'Instrumento inexistente.');
      if (!i.tradable)
        throw new MarketDataError(
          422,
          'NOT_TRADABLE',
          'Só instrumentos do universo têm referência.',
        );
      await tx.insertOverride(row);
    });
    // O valor fixado entra na hora (a fronteira do override é um evento do modelo).
    await this.advance(input.instrumentId);
    return {
      overrideId: row.id,
      instrumentId: row.instrumentId,
      price: row.price,
      validFrom: row.validFrom.toString(),
      validUntil: row.validUntil.toString(),
    };
  }

  /** RN-SYN-004: liga ou desliga o ruído de um instrumento. */
  async setNoise(instrumentId: string, enabled: boolean, by: string): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      if (!(await tx.instrument(instrumentId)))
        throw new MarketDataError(404, 'INSTRUMENT_NOT_FOUND', 'Instrumento inexistente.');
      await tx.setNoise(instrumentId, enabled, by, this.d.clock.now());
    });
  }

  async view(instrumentId: string): Promise<ReferenceView> {
    return this.d.store.transaction(async (tx) => {
      const s = await tx.referenceState(instrumentId);
      if (!s) throw new MarketDataError(404, 'REFERENCE_NOT_FOUND', 'Sem preço de referência.');
      return {
        instrumentId,
        price: s.lastPrice,
        origin: s.lastOrigin,
        anchorPrice: s.anchor,
        externalQuoteTime: s.externalQuoteTime,
        seq: s.seq,
        tradingDate: s.tradingDate,
        noiseEnabled: await this.noiseOn(tx, instrumentId),
      };
    });
  }

  /** Valores mais velhos que isto não são publicados (subida no meio do dia, pausa longa). */
  private emitFrom(now: Instant): Instant {
    return now.plusMillis(-CATCH_UP_MS);
  }

  private async noiseOn(tx: MarketDataTx, instrumentId: string): Promise<boolean> {
    return this.d.synthetic.noiseEnabled && ((await tx.noiseEnabled(instrumentId)) ?? true);
  }

  /**
   * Carrega o modelo do dia. Dia novo: semente `(environment, instrument_id, trading_date)`, âncora
   * herdada (último preço aceito, o fechamento) e cursor no início do dia, para o resultado não
   * depender da hora em que a primeira rodada aconteceu.
   */
  private async load(
    tx: MarketDataTx,
    instrumentId: string,
    now: Instant,
    firstAnchor?: string,
  ): Promise<{ model: ReferencePriceModel; fresh: boolean } | null> {
    const instrument = await tx.instrument(instrumentId);
    if (!instrument) return null;
    const date = now.businessDate();
    const params = { ...this.d.synthetic, noiseEnabled: await this.noiseOn(tx, instrumentId) };
    const window = this.continuous(date);
    const state = await tx.referenceState(instrumentId, { forUpdate: true });
    if (state && state.tradingDate === date.toString())
      return { model: ReferencePriceModel.restore(state, params, window), fresh: false };
    const quote = await tx.quote(instrument.symbol);
    const anchor = state?.anchor ?? quote?.quote.lastPrice ?? firstAnchor;
    if (!anchor) return null;
    const model = ReferencePriceModel.open({
      seed: referenceSeed(this.d.environment, instrumentId, date.toString()),
      instrumentId,
      tradingDate: date.toString(),
      anchor,
      externalQuoteTime: quote?.quote.quoteTime.toString() ?? state?.externalQuoteTime ?? null,
      at: date.atLocalTime('00:00'),
      previousSeq: state?.seq ?? 0,
      params,
      window,
      sigma: await this.sigma(tx, instrument),
    });
    return { model, fresh: true };
  }

  private async sigma(tx: MarketDataTx, instrument: InstrumentRef): Promise<number> {
    const candles = await tx.candles(instrument.symbol);
    const closes = candles.slice(-VOLATILITY_DAYS).map((c) => c.adjustedClose ?? c.close);
    const intervalMs = (this.d.synthetic.tickMinMs + this.d.synthetic.tickMaxMs) / 2;
    return Math.max(this.d.synthetic.sigma, sigmaPerTick(closes, intervalMs));
  }

  private continuous(date: BusinessDate): ContinuousWindow | null {
    try {
      const p = this.d.calendar.sessionSchedule(date)?.phases.find((x) => x.phase === 'CONTINUOUS');
      return p ? { from: p.startsAt, to: p.endsAt } : null;
    } catch (err) {
      if (err instanceof CalendarNotLoadedError) return null;
      throw err;
    }
  }

  private async overrides(
    tx: MarketDataTx,
    instrumentId: string,
    now: Instant,
  ): Promise<ManualOverride[]> {
    const dayStart = now.businessDate().atLocalTime('00:00');
    return (await tx.overrides(instrumentId, dayStart, now.plusMillis(86_400_000))).map((o) => ({
      price: o.price,
      from: o.validFrom,
      until: o.validUntil,
    }));
  }

  private async persist(tx: MarketDataTx, model: ReferencePriceModel, updates: ReferenceUpdate[]) {
    await tx.saveReferenceState(model.state());
    for (const u of updates) {
      await tx.publish(
        {
          type: 'market_data.reference_price_updated',
          payload: {
            instrumentId: u.instrumentId,
            seq: u.seq,
            price: u.price,
            origin: u.origin,
            anchorPrice: u.anchorPrice,
            externalQuoteTime: u.externalQuoteTime,
            at: u.at.toString(),
          },
        },
        u.instrumentId,
      );
    }
  }
}
