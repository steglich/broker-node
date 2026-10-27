import { CalendarNotLoadedError } from '@broker/calendar';
import type { Instant } from '@broker/domain-kernel';
import { universeIntervalMs, type Priority, type RequestKind } from '../domain/budget.js';
import { IBOVESPA, isIndex } from '../domain/quote.js';
import { insideWindow, jitterMs, nextRead, quoteWindow } from '../domain/schedule.js';
import type { BudgetController } from './budget.js';
import type { MarketDataDeps } from './context.js';
import type { ProviderHealth } from './errors.js';
import type { ScheduleRow } from './ports.js';
import { ProviderError } from './provider.js';
import type { IngestResult, Quotes } from './quotes.js';
import { RequestDenied, type ProviderQueue } from './queue.js';

/**
 * Leituras agendadas das cotações do universo e do Ibovespa (RN-BRP-050..053):
 * - só dentro da janela do pregão (≈ 10:05 até o fim do call): nada em fim de semana e feriado;
 * - P0 para instrumentos com posição ou ordem aberta, P1 para o resto do universo, P2 Ibovespa;
 * - próxima leitura em `quote_time + update_interval + folga`, ou +5 min sem mudança (3×);
 * - em `SAVING`/`CRITICAL` o universo é lido a cada 60 min (Brapi §5.3).
 */
export class QuotePoller {
  constructor(
    private readonly d: MarketDataDeps,
    private readonly queue: ProviderQueue,
    private readonly quotes: Quotes,
    private readonly budget: BudgetController,
    private readonly health: ProviderHealth,
  ) {}

  /** Janela de leituras de hoje (`null` sem pregão ou com o calendário fora do período). */
  window(now: Instant = this.d.clock.now()) {
    try {
      return quoteWindow(this.d.calendar.sessionSchedule(now.businessDate()));
    } catch (err) {
      if (err instanceof CalendarNotLoadedError) return null;
      throw err;
    }
  }

  inSession(now: Instant = this.d.clock.now()): boolean {
    return insideWindow(this.window(now), now);
  }

  /** Uma rodada: enfileira as leituras vencidas. Devolve quantas foram enfileiradas. */
  async tick(): Promise<number> {
    const now = this.d.clock.now();
    const window = this.window(now);
    if (!insideWindow(window, now)) return 0;
    const { targets, schedules } = await this.d.store.transaction(async (tx) => ({
      targets: [...(await tx.tradableInstruments()).map((i) => i.symbol), IBOVESPA],
      schedules: new Map((await tx.schedules()).map((s) => [s.symbol, s])),
    }));
    const exposed = await this.d.exposure.exposedInstruments();
    const ids = await this.d.store.transaction(async (tx) => {
      const m = new Map<string, string>();
      for (const s of targets) {
        const i = isIndex(s) ? null : await tx.instrumentBySymbol(s);
        if (i) m.set(s, i.instrumentId);
      }
      return m;
    });
    let n = 0;
    for (const symbol of targets) {
      const sched = schedules.get(symbol);
      if (sched && sched.nextReadAt.isAfter(now)) continue;
      if (this.queue.has(`quote:${symbol}`)) continue;
      const id = ids.get(symbol);
      const priority: Priority = isIndex(symbol) ? 2 : id && exposed.has(id) ? 0 : 1;
      void this.read(symbol, priority, sched ?? null).catch((err: unknown) =>
        this.d.logger.error({ event: 'market_data.read_failed', err, symbol }, 'falha na leitura'),
      );
      n++;
    }
    return n;
  }

  /** Lê um símbolo pela fila, grava a leitura e reagenda. */
  async read(
    symbol: string,
    priority: Priority,
    sched: ScheduleRow | null,
  ): Promise<IngestResult | null> {
    const kind: RequestKind = isIndex(symbol) ? 'INDEX_QUOTE' : 'QUOTE';
    let result: IngestResult | null = null;
    try {
      const response = await this.queue.enqueue({
        key: `quote:${symbol}`,
        symbol,
        kind,
        priority,
        run: () => this.d.provider.getQuote(symbol),
      });
      result = await this.quotes.ingest(response);
    } catch (err) {
      await this.health.report(kind, err, { symbol });
      if (!(err instanceof ProviderError) && !(err instanceof RequestDenied)) throw err;
    } finally {
      await this.reschedule(symbol, sched, result);
    }
    return result;
  }

  /**
   * Leitura pós-fechamento das 18:00 (RN-BRP-052): uma por instrumento do universo e do Ibovespa,
   * para o fechamento oficial. O candle diário externo do dia sai deste snapshot (RN-BRP-062).
   */
  async closeSnapshot(): Promise<{ read: number; candles: number; failed: number }> {
    const today = this.d.clock.now().businessDate();
    const targets = await this.d.store.transaction(async (tx) => [
      ...(await tx.tradableInstruments()).map((i) => i.symbol),
      IBOVESPA,
    ]);
    let read = 0;
    let candles = 0;
    let failed = 0;
    await Promise.all(
      targets.map(async (symbol) => {
        const kind: RequestKind = isIndex(symbol) ? 'INDEX_QUOTE' : 'QUOTE';
        try {
          const response = await this.queue.enqueue({
            key: `quote:${symbol}`,
            symbol,
            kind,
            priority: isIndex(symbol) ? 2 : 1,
            run: () => this.d.provider.getQuote(symbol),
          });
          const r = await this.quotes.ingest(response);
          read++;
          const q = r.current?.quote;
          if (q && q.quoteTime.businessDate().equals(today)) {
            await this.d.store.transaction((tx) =>
              tx.upsertCandles(
                symbol,
                [
                  {
                    date: today,
                    open: q.open ?? q.lastPrice,
                    high: q.high ?? q.lastPrice,
                    low: q.low ?? q.lastPrice,
                    close: q.lastPrice,
                    adjustedClose: null,
                    volume: q.volume ?? '0',
                  },
                ],
                'CLOSE_SNAPSHOT',
              ),
            );
            candles++;
          }
        } catch (err) {
          failed++;
          await this.health.report(kind, err, { symbol });
        }
      }),
    );
    return { read, candles, failed };
  }

  private async reschedule(symbol: string, sched: ScheduleRow | null, r: IngestResult | null) {
    const now = this.d.clock.now();
    const interval = universeIntervalMs(this.budget.level(), this.d.plan.updateIntervalMs);
    const prev = sched?.lastQuoteTime ?? null;
    const quoteTime = r ? r.quote.quoteTime : null;
    const next = nextRead({
      now,
      previousQuoteTime: prev,
      quoteTime,
      unchangedRetries: sched?.unchangedRetries ?? 0,
      updateIntervalMs: interval,
      jitterMs: jitterMs(this.d.random()),
    });
    await this.d.store.transaction((tx) =>
      tx.saveSchedule({
        symbol,
        nextReadAt: next.nextReadAt,
        unchangedRetries: next.unchangedRetries,
        lastQuoteTime: quoteTime && (!prev || quoteTime.isAfter(prev)) ? quoteTime : prev,
      }),
    );
  }
}
