import { CalendarNotLoadedError } from '@broker/calendar';
import { BusinessDate, type Instant } from '@broker/domain-kernel';
import { effectivePhase, type Phase } from '../domain/phases.js';
import { notFound, type SessionDeps } from './context.js';
import type { Auction, InstrumentState, MarketState, SessionTx } from './ports.js';

const auctionView = (a: Auction) => ({
  auctionId: a.id,
  type: a.type,
  status: a.status,
  startedAt: a.startedAt.toString(),
  expectedEndAt: a.expectedEndAt.toString(),
  effectiveEndAt: a.effectiveEndAt?.toString() ?? null,
  extensions: a.extensions,
  theoreticalPrice: a.theoreticalPrice?.toFixed() ?? null,
});

/** Consulta do estado da sessão (Contratos §4). */
export class SessionQueries {
  constructor(private readonly d: SessionDeps) {}

  /** Próximas fases da grade: o resto do dia ou a abertura do próximo dia útil. */
  private nextEvents(now: Instant): { phase: Phase; at: string }[] {
    const { calendar } = this.d;
    try {
      const today = now.businessDate();
      const windows = (date: BusinessDate) => calendar.sessionSchedule(date)?.phases ?? [];
      const upcoming = windows(today)
        .filter((w) => w.startsAt.isAfter(now))
        .map((w) => ({ phase: w.phase as Phase, at: w.startsAt.toString() }));
      const last = windows(today).at(-1);
      if (last?.endsAt.isAfter(now)) upcoming.push({ phase: 'CLOSED', at: last.endsAt.toString() });
      if (upcoming.length > 0) return upcoming;
      const first = windows(calendar.nextBusinessDay(today))[0];
      return first ? [{ phase: first.phase, at: first.startsAt.toString() }] : [];
    } catch (err) {
      if (err instanceof CalendarNotLoadedError) return [];
      throw err;
    }
  }

  private async instrumentView(tx: SessionTx, m: MarketState, i: InstrumentState) {
    const auction = (await tx.liveAuctions(i.id))[0];
    const phase = effectivePhase(m.phase, i.phase);
    const own = i.phase !== null && phase === i.phase;
    return {
      instrumentId: i.id,
      symbol: i.symbol,
      phase,
      reason: own ? i.reason : m.reason,
      since: (own ? i.since : m.since)?.toString() ?? null,
      expectedEndAt:
        (auction?.expectedEndAt ?? (own ? i.expectedEndAt : m.expectedEndAt))?.toString() ?? null,
      auction: auction ? auctionView(auction) : null,
      previousClose: i.previousClose?.toFixed() ?? null,
      bandReferencePrice: i.bandReferencePrice?.toFixed() ?? null,
    };
  }

  session() {
    return this.d.store.transaction(async (tx) => {
      const m = await tx.market();
      const now = this.d.clock.now();
      const day = m.businessDate ? await tx.tradingDay(m.businessDate) : null;
      const instruments = await tx.tradableInstruments();
      return {
        businessDate: m.businessDate?.toString() ?? null,
        tradingDayStatus: day?.status ?? null,
        market: {
          phase: m.phase,
          scheduledPhase: m.scheduledPhase,
          since: m.since.toString(),
          expectedEndAt: m.expectedEndAt?.toString() ?? null,
          reason: m.reason,
        },
        instruments: await Promise.all(instruments.map((i) => this.instrumentView(tx, m, i))),
        nextEvents: this.nextEvents(now),
      };
    });
  }

  instrument(symbol: string) {
    return this.d.store.transaction(async (tx) => {
      const i = await tx.instrumentBySymbol(symbol);
      if (!i) throw notFound('Instrumento inexistente.');
      return {
        ...(await this.instrumentView(tx, await tx.market(), i)),
        nextEvents: this.nextEvents(this.d.clock.now()),
      };
    });
  }

  halts(active: boolean | undefined, limit: number) {
    return this.d.store.transaction((tx) =>
      tx.halts({ ...(active === undefined ? {} : { active }), limit }),
    );
  }

  alerts(limit: number) {
    return this.d.store.transaction((tx) => tx.alerts(limit));
  }

  closingPrices(date: BusinessDate) {
    return this.d.store.transaction((tx) => tx.closingPrices(date));
  }

  circuitBreakers(date: BusinessDate) {
    return this.d.store.transaction((tx) => tx.circuitBreakerEvents(date));
  }
}
