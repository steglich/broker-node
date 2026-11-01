import { CalendarNotLoadedError } from '@broker/calendar';
import { BusinessDate, Decimal, Instant } from '@broker/domain-kernel';
import { murmur32 } from '@broker/messaging';
import { decideAuctionEnd, type AuctionType, type PriceLimit } from '../domain/auction.js';
import {
  CIRCUIT_BREAKER_LEVELS,
  CIRCUIT_BREAKER_RESUME_AUCTION_S,
  circuitBreakerReason,
  evaluateCircuitBreaker,
  indexChange,
  type CircuitBreakerLevel,
} from '../domain/circuit-breaker.js';
import { closeDiverges, closingPrice } from '../domain/closing.js';
import {
  DEFAULT_RESUME_AUCTION_S,
  HaltReason,
  haltReasonOfStatus,
  STATUS_HALT_REASONS,
} from '../domain/halts.js';
import {
  CALENDAR_CHECK_ROUTINE,
  effectivePhase,
  ROUTINE_PHASES,
  type Phase,
} from '../domain/phases.js';
import type { SessionRules } from '../domain/trading-rules.js';
import { SYSTEM, type SessionDeps } from './context.js';
import type {
  Auction,
  Halt,
  InstrumentState,
  MarketState,
  PhaseChangeCommand,
  SessionEvent,
  SessionTx,
} from './ports.js';

type EngineExtras = Omit<PhaseChangeCommand, 'scope' | 'phase'>;
type Stats = Record<string, unknown>;

const POST_CLOSE_ROUTINE = 'post_close';
const AUCTION_PHASES: readonly Phase[] = ['PRE_OPENING', 'VOLATILITY_AUCTION'];

const auctionPhase = (type: AuctionType): Phase =>
  type === 'VOLATILITY'
    ? 'VOLATILITY_AUCTION'
    : type === 'CLOSING'
      ? 'CLOSING_CALL'
      : 'PRE_OPENING';

export interface HaltRequest {
  scope: string;
  reasonCode: string;
  description?: string | null;
  resumeAt?: Instant | null;
  resumeAuctionS?: number;
  cancelAllOnHalt?: boolean;
  actorId?: string;
  approvalRequestId?: string | null;
}

/**
 * Máquina de fases do mercado e dos instrumentos (Pregão §4–§9). Toda mudança de fase roda com a
 * linha do mercado travada (`lockMarket`), na transação do caso de uso, com a outbox.
 *
 * O Motor só conhece a fase efetiva de cada instrumento: a chave de `engine.commands` é o
 * `instrument_id`, então uma mudança de mercado vira um `PhaseChange` por instrumento, e só para
 * quem a fase efetiva muda (`engine_phase` guarda a última enviada).
 *
 * Quem encerra leilão é a sessão: no fim previsto ela decide (RN-AUC-003) e manda a fase seguinte
 * com `concludesAuctionId`; o Motor conclui na janela aleatória e responde `engine.auction_completed`.
 */
export class Session {
  constructor(private readonly d: SessionDeps) {}

  private now(): Instant {
    return this.d.clock.now();
  }

  // ------------------------------------------------------------------- rotinas (Pregão §8)

  /** RN-ROT-001: um efeito por `(routineName, businessDate)`; re-disparo só confirma de novo. */
  async onRoutine(
    tx: SessionTx,
    p: { routineName: string; businessDate: string; executionId: string },
  ): Promise<void> {
    const phase = ROUTINE_PHASES[p.routineName];
    if (p.routineName !== CALENDAR_CHECK_ROUTINE && !phase) return;
    const date = BusinessDate.parse(p.businessDate);
    const market = await tx.lockMarket();
    const previous = await tx.routine(p.routineName, date);
    if (previous) {
      await this.finishRoutine(
        tx,
        p.routineName,
        date,
        p.executionId,
        previous.status,
        previous.stats,
      );
      return;
    }
    if (!phase) {
      await this.completeRoutine(tx, p, date, await this.calendarCheck(tx, market, date));
      return;
    }
    market.businessDate = date;
    market.scheduledPhase = phase;
    const pending = await this.applyScheduledPhase(tx, market, phase, date);
    if (pending) {
      await this.finishRoutine(tx, p.routineName, date, p.executionId, 'PENDING', pending);
      return;
    }
    await this.completeRoutine(tx, p, date, { phase });
  }

  private completeRoutine(
    tx: SessionTx,
    p: { routineName: string; executionId: string },
    date: BusinessDate,
    stats: Stats,
  ) {
    return this.finishRoutine(tx, p.routineName, date, p.executionId, 'COMPLETED', stats);
  }

  private async finishRoutine(
    tx: SessionTx,
    name: string,
    date: BusinessDate,
    executionId: string,
    status: 'PENDING' | 'COMPLETED',
    stats: Stats,
  ): Promise<void> {
    await tx.saveRoutine({ name, date, executionId, status, stats });
    if (status === 'COMPLETED')
      await tx.publish(
        {
          type: 'routine.completed',
          payload: { routineName: name, businessDate: date.toString(), executionId, stats },
        },
        name,
      );
  }

  /** Rotina das 07:00: em dia útil, abre o dia e manda a referência dos túneis (RN-INS-040). */
  private async calendarCheck(
    tx: SessionTx,
    market: MarketState,
    date: BusinessDate,
  ): Promise<Stats> {
    if (!this.d.calendar.isBusinessDay(date))
      return { opened: false, dayType: this.d.calendar.dayType(date) };
    const day = await tx.tradingDay(date);
    if (day?.status === 'OPEN' || day?.status === 'CLOSED') return { opened: false };
    await tx.openTradingDay(date, this.now());
    await tx.publish(
      { type: 'session.trading_day_opened', payload: { businessDate: date.toString() } },
      'MARKET',
    );
    market.businessDate = date;
    await tx.saveMarket(market);
    const instruments = await tx.tradableInstruments();
    for (const i of instruments) await this.sendBandUpdate(tx, i);
    return { opened: true, instruments: instruments.length };
  }

  /** Devolve as estatísticas de espera quando a rotina só termina depois (calls prorrogadas). */
  private async applyScheduledPhase(
    tx: SessionTx,
    m: MarketState,
    phase: Phase,
    date: BusinessDate,
  ): Promise<Stats | null> {
    // Mercado suspenso: a grade anda por baixo e a retomada volta para a fase da grade (§5).
    if (m.phase === 'HALTED' && phase !== 'POST_CLOSE' && phase !== 'CLOSED') {
      await tx.saveMarket(m);
      return null;
    }
    const end = this.expectedEnd(date, phase);
    switch (phase) {
      case 'PRE_OPENING':
      case 'CLOSING_CALL': {
        await this.cancelLiveAuctions(tx, m, 'NEXT_PHASE');
        const type: AuctionType = phase === 'PRE_OPENING' ? 'OPENING' : 'CLOSING';
        const extras = await this.openMarketAuctions(tx, type, date, end ?? this.now());
        await this.transitionMarket(tx, m, phase, 'SCHEDULE', end, extras);
        return null;
      }
      case 'CONTINUOUS':
        await this.settleMarketAuctions(tx, m, 'CONTINUOUS');
        await this.transitionMarket(tx, m, 'CONTINUOUS', 'SCHEDULE', end);
        return null;
      case 'POST_CLOSE':
        return this.startPostClose(tx, m, date, end);
      case 'CLOSED':
        await this.closeDay(tx, m, date, end);
        return null;
      default:
        await this.transitionMarket(tx, m, phase, 'SCHEDULE', end);
        return null;
    }
  }

  /** Fim previsto da fase na grade; `null` se já passou (catch-up) ou sem calendário carregado. */
  private expectedEnd(date: BusinessDate, phase: Phase): Instant | null {
    try {
      const { calendar } = this.d;
      const end =
        phase === 'CLOSED'
          ? calendar.sessionSchedule(calendar.nextBusinessDay(date))?.phases[0]?.startsAt
          : calendar.sessionSchedule(date)?.phases.find((w) => w.phase === phase)?.endsAt;
      return end?.isAfter(this.now()) ? end : null;
    } catch (err) {
      if (err instanceof CalendarNotLoadedError) return null;
      throw err;
    }
  }

  /**
   * RN-AUC-003 na call: quem precisa de prorrogação segue em `CLOSING_CALL` e o mercado só vai a
   * `POST_CLOSE` quando a última terminar. A rotina fica pendente até lá, e isso segura o fim do dia
   * das ordens (`eod_orders` depende dela, RN-ROT-002). Quem já concluiu vai antes, pela fase própria.
   */
  private async startPostClose(
    tx: SessionTx,
    m: MarketState,
    date: BusinessDate,
    end: Instant | null,
  ): Promise<Stats | null> {
    for (const halt of await tx.activeHalts('MARKET'))
      await this.closeHalt(tx, halt, { resume: false, market: m });
    for (const a of await tx.liveAuctions())
      if (a.type !== 'CLOSING') await this.cancelAuction(tx, m, a, 'NEXT_PHASE');
    const concluded: string[] = [];
    for (const a of await tx.liveAuctions()) {
      if (!a.marketScoped) continue;
      if (await this.decideAuction(tx, m, a, 'POST_CLOSE')) concluded.push(a.instrumentId);
    }
    if ((await tx.liveAuctions()).length === 0) {
      await this.transitionMarket(tx, m, 'POST_CLOSE', 'SCHEDULE', end);
      return null;
    }
    await tx.saveMarket(m);
    for (const id of concluded) {
      const inst = await tx.instrument(id);
      if (inst) await this.setInstrumentPhase(tx, m, inst, 'POST_CLOSE', 'SCHEDULE', end);
    }
    return { waitingClosingCalls: true };
  }

  /** Termina o `post_close` pendente quando não resta call aberta. */
  private async finishPostClose(tx: SessionTx, m: MarketState): Promise<boolean> {
    const date = m.businessDate;
    if (!date) return false;
    const routine = await tx.routine(POST_CLOSE_ROUTINE, date);
    if (routine?.status !== 'PENDING' || (await tx.liveAuctions()).length > 0) return false;
    for (const inst of await tx.tradableInstruments()) {
      if (inst.phase !== 'POST_CLOSE') continue;
      inst.phase = null;
      inst.reason = null;
      inst.expectedEndAt = null;
      await tx.saveInstrument(inst);
    }
    await this.transitionMarket(
      tx,
      m,
      'POST_CLOSE',
      'SCHEDULE',
      this.expectedEnd(date, 'POST_CLOSE'),
    );
    await this.finishRoutine(tx, POST_CLOSE_ROUTINE, date, routine.executionId, 'COMPLETED', {
      phase: 'POST_CLOSE',
    });
    return true;
  }

  private async closeDay(
    tx: SessionTx,
    m: MarketState,
    date: BusinessDate,
    end: Instant | null,
  ): Promise<void> {
    await this.defineClosingPrices(tx, date);
    await this.transitionMarket(tx, m, 'CLOSED', 'SCHEDULE', end);
    await tx.closeTradingDay(date, this.now());
    await tx.publish(
      { type: 'session.trading_day_closed', payload: { businessDate: date.toString() } },
      'MARKET',
    );
  }

  // ------------------------------------------------------------------- fases

  private async transitionMarket(
    tx: SessionTx,
    m: MarketState,
    to: Phase,
    reason: string,
    expectedEnd: Instant | null,
    extras: ReadonlyMap<string, EngineExtras> = new Map(),
    actor = SYSTEM,
  ): Promise<void> {
    const now = this.now();
    const from = m.phase;
    m.phase = to;
    m.since = now;
    m.expectedEndAt = expectedEnd;
    m.reason = reason;
    await tx.saveMarket(m);
    if (from !== to) {
      await tx.insertTransition({
        id: this.d.newId(),
        scope: 'MARKET',
        from,
        to,
        reason,
        effectiveAt: now,
        actor,
      });
      await tx.publish(
        {
          type: 'session.phase_changed',
          payload: {
            scope: 'MARKET',
            from,
            to,
            reason,
            effectiveAt: now.toString(),
            expectedEndAt: expectedEnd?.toString() ?? null,
          },
        },
        'MARKET',
      );
    }
    for (const inst of await tx.tradableInstruments()) {
      const before = effectivePhase(from, inst.phase);
      const after = effectivePhase(to, inst.phase);
      // Quem segue o mercado já foi informado pelo evento `MARKET`.
      if (inst.phase !== null && before !== after)
        await this.publishInstrumentPhase(tx, inst, before, after, reason, inst.expectedEndAt);
      const extra = extras.get(inst.id);
      if (after !== inst.enginePhase) await this.sendPhase(tx, inst, after, extra);
    }
  }

  /** Muda a fase própria do instrumento (RN-SES-001/002). */
  private async setInstrumentPhase(
    tx: SessionTx,
    m: MarketState,
    inst: InstrumentState,
    phase: Phase | null,
    reason: string,
    expectedEnd: Instant | null,
    opts: { auctionId?: string; extras?: EngineExtras; skipEngine?: boolean } = {},
  ): Promise<void> {
    const before = effectivePhase(m.phase, inst.phase);
    inst.phase = phase;
    inst.since = phase ? this.now() : null;
    inst.expectedEndAt = phase ? expectedEnd : null;
    inst.reason = phase ? reason : null;
    const after = effectivePhase(m.phase, phase);
    if (before !== after)
      await this.publishInstrumentPhase(
        tx,
        inst,
        before,
        after,
        reason,
        expectedEnd,
        opts.auctionId,
      );
    if (!opts.skipEngine && after !== inst.enginePhase)
      await this.sendPhase(tx, inst, after, opts.extras);
    else await tx.saveInstrument(inst);
  }

  private async publishInstrumentPhase(
    tx: SessionTx,
    inst: InstrumentState,
    from: Phase,
    to: Phase,
    reason: string,
    expectedEnd: Instant | null,
    auctionId?: string,
  ): Promise<void> {
    const now = this.now();
    if (from !== to)
      await tx.insertTransition({
        id: this.d.newId(),
        scope: inst.id,
        from,
        to,
        reason,
        effectiveAt: now,
        actor: SYSTEM,
      });
    await tx.publish(
      {
        type: 'session.phase_changed',
        payload: {
          scope: inst.id,
          from,
          to,
          reason,
          effectiveAt: now.toString(),
          expectedEndAt: expectedEnd?.toString() ?? null,
          ...(auctionId ? { auctionId } : {}),
        },
      },
      inst.id,
    );
  }

  private async sendPhase(
    tx: SessionTx,
    inst: InstrumentState,
    phase: Phase,
    extras: EngineExtras = {},
  ): Promise<void> {
    await tx.publish(
      { type: 'engine.phase_change', payload: { scope: inst.id, phase, ...extras } },
      inst.id,
    );
    inst.enginePhase = phase;
    await tx.saveInstrument(inst);
  }

  private async sendBandUpdate(tx: SessionTx, inst: InstrumentState): Promise<void> {
    if (!inst.bandReferencePrice) return;
    const rules = await tx.rulesAt(inst.id, this.now());
    await tx.publish(bandUpdate(inst.id, inst.bandReferencePrice, rules), inst.id);
  }

  // ------------------------------------------------------------------- leilões (RN-AUC-001..003)

  private async openAuction(
    tx: SessionTx,
    inst: InstrumentState,
    type: AuctionType,
    date: BusinessDate,
    expectedEnd: Instant,
    marketScoped: boolean,
  ): Promise<{ auction: Auction; extras: EngineExtras }> {
    const auction: Auction = {
      id: this.d.newId(),
      instrumentId: inst.id,
      type,
      status: 'OPEN',
      marketScoped,
      businessDate: date,
      startedAt: this.now(),
      expectedEndAt: expectedEnd,
      effectiveEndAt: null,
      extensions: 0,
      theoreticalPrice: null,
      theoreticalQuantity: null,
      price: null,
      quantity: null,
    };
    await tx.insertAuction(auction);
    return {
      auction,
      extras: {
        auctionId: auction.id,
        auctionType: type,
        auctionEndAt: expectedEnd.toString(),
        randomSeed: String(murmur32(auction.id)),
      },
    };
  }

  /** Um leilão por instrumento negociável e não suspenso. */
  private async openMarketAuctions(
    tx: SessionTx,
    type: AuctionType,
    date: BusinessDate,
    expectedEnd: Instant,
  ): Promise<Map<string, EngineExtras>> {
    const extras = new Map<string, EngineExtras>();
    for (const inst of await tx.tradableInstruments()) {
      if (inst.phase === 'HALTED') continue;
      const opened = await this.openAuction(tx, inst, type, date, expectedEnd, true);
      extras.set(inst.id, opened.extras);
    }
    return extras;
  }

  private async settleMarketAuctions(tx: SessionTx, m: MarketState, target: Phase): Promise<void> {
    for (const a of await tx.liveAuctions())
      if (a.marketScoped) await this.decideAuction(tx, m, a, target);
  }

  /**
   * Fim previsto de um leilão (RN-AUC-003). Devolve `true` se mandou concluir. Na prorrogação, o
   * leilão de um mercado que segue em frente passa a ser do instrumento, com fase própria.
   */
  private async decideAuction(
    tx: SessionTx,
    m: MarketState,
    a: Auction,
    target: Phase,
  ): Promise<boolean> {
    const inst = await tx.instrument(a.instrumentId);
    if (!inst) return false;
    const now = this.now();
    const rules = await tx.rulesAt(inst.id, now);
    const { params } = this.d;
    const decision = decideAuctionEnd({
      theoreticalPrice: a.theoreticalPrice,
      bandReferencePrice: inst.bandReferencePrice,
      staticBandPct: new Decimal(rules.staticAuctionBandPct),
      extensions: a.extensions,
      maxExtensions: params.maxAuctionExtensions,
      policy: params.auctionExtensionPolicy,
    });
    if (decision.kind === 'CONCLUDE') {
      if (decision.alert) await this.alertExtensionsExhausted(tx, inst, a);
      await this.concludeAuction(tx, inst, a, target, decision.priceLimit);
      return true;
    }
    a.marketScoped = false;
    const phase = auctionPhase(a.type);
    if (decision.kind === 'HOLD') {
      a.status = 'HELD';
      await tx.saveAuction(a);
      await this.alertExtensionsExhausted(tx, inst, a);
      if (a.type !== 'CLOSING' && inst.phase !== phase)
        await this.setInstrumentPhase(tx, m, inst, phase, 'AUCTION_HELD', a.expectedEndAt, {
          auctionId: a.id,
          skipEngine: true,
        });
      return false;
    }
    a.expectedEndAt = now.plusMillis(rules.volatilityAuctionExtensionS * 1000);
    a.extensions += 1;
    await tx.saveAuction(a);
    if (a.type !== 'CLOSING') {
      inst.phase = phase;
      inst.since = inst.since ?? now;
      inst.reason = 'AUCTION_EXTENDED';
      inst.expectedEndAt = a.expectedEndAt;
    }
    // A fase não muda: o evento leva o novo fim previsto.
    await this.publishInstrumentPhase(
      tx,
      inst,
      phase,
      phase,
      'AUCTION_EXTENDED',
      a.expectedEndAt,
      a.id,
    );
    await this.sendPhase(tx, inst, phase, {
      auctionId: a.id,
      auctionType: a.type,
      auctionEndAt: a.expectedEndAt.toString(),
      randomSeed: String(murmur32(a.id)),
    });
    return false;
  }

  private async concludeAuction(
    tx: SessionTx,
    inst: InstrumentState,
    a: Auction,
    target: Phase,
    priceLimit?: PriceLimit,
  ): Promise<void> {
    a.status = 'CONCLUDING';
    await tx.saveAuction(a);
    await this.sendPhase(tx, inst, target, {
      concludesAuctionId: a.id,
      ...(priceLimit ? { priceLimit } : {}),
    });
  }

  private async alertExtensionsExhausted(tx: SessionTx, inst: InstrumentState, a: Auction) {
    await this.alert(
      tx,
      'AUCTION_EXTENSIONS_EXHAUSTED',
      `AUCTION_EXTENSIONS_EXHAUSTED:${a.id}`,
      `Leilão de ${inst.symbol} esgotou as prorrogações com o preço teórico fora do túnel.`,
      {
        auctionId: a.id,
        instrumentId: inst.id,
        symbol: inst.symbol,
        type: a.type,
        policy: this.d.params.auctionExtensionPolicy,
        theoreticalPrice: a.theoreticalPrice?.toFixed() ?? null,
      },
    );
  }

  private async cancelLiveAuctions(tx: SessionTx, m: MarketState, reason: string): Promise<void> {
    for (const a of await tx.liveAuctions()) await this.cancelAuction(tx, m, a, reason);
  }

  private async cancelAuction(
    tx: SessionTx,
    m: MarketState,
    a: Auction,
    reason: string,
  ): Promise<void> {
    a.status = 'CANCELED';
    a.effectiveEndAt = this.now();
    await tx.saveAuction(a);
    const inst = await tx.instrument(a.instrumentId);
    if (inst?.phase && AUCTION_PHASES.includes(inst.phase))
      await this.setInstrumentPhase(tx, m, inst, null, reason, null, { skipEngine: true });
  }

  /** Conclusão manual de um leilão mantido ou aberto (RN-AUC-003). */
  async concludeAuctionById(tx: SessionTx, auctionId: string): Promise<Auction | null> {
    const m = await tx.lockMarket();
    const a = await tx.auction(auctionId, { forUpdate: true });
    if (!a || (a.status !== 'OPEN' && a.status !== 'HELD')) return null;
    const inst = await tx.instrument(a.instrumentId);
    if (!inst) return null;
    const rules = await tx.rulesAt(inst.id, this.now());
    const decision = decideAuctionEnd({
      theoreticalPrice: a.theoreticalPrice,
      bandReferencePrice: inst.bandReferencePrice,
      staticBandPct: new Decimal(rules.staticAuctionBandPct),
      extensions: 0,
      maxExtensions: 0,
      policy: 'CONCLUDE_AT_BAND',
    });
    const closing = a.type === 'CLOSING';
    await this.concludeAuction(
      tx,
      inst,
      a,
      closing ? 'POST_CLOSE' : m.phase,
      decision.kind === 'CONCLUDE' ? decision.priceLimit : undefined,
    );
    if (closing) {
      await this.setInstrumentPhase(tx, m, inst, 'POST_CLOSE', 'SCHEDULE', null);
      await this.finishPostClose(tx, m);
    }
    return a;
  }

  /** RN-AUC-030..032: o Motor abriu um leilão por volatilidade. */
  async onAuctionTriggered(
    tx: SessionTx,
    e: { instrumentId: string; board: string; auctionId: string; expectedEndAt: string },
  ): Promise<void> {
    if (e.board !== 'MAIN') return;
    const m = await tx.lockMarket();
    const inst = await tx.instrument(e.instrumentId, { forUpdate: true });
    if (!inst || (await tx.auction(e.auctionId))) return;
    const expectedEnd = Instant.parse(e.expectedEndAt);
    await tx.insertAuction({
      id: e.auctionId,
      instrumentId: inst.id,
      type: 'VOLATILITY',
      status: 'OPEN',
      marketScoped: false,
      businessDate: m.businessDate ?? this.now().businessDate(),
      startedAt: this.now(),
      expectedEndAt: expectedEnd,
      effectiveEndAt: null,
      extensions: 0,
      theoreticalPrice: null,
      theoreticalQuantity: null,
      price: null,
      quantity: null,
    });
    inst.enginePhase = 'VOLATILITY_AUCTION';
    await this.setInstrumentPhase(tx, m, inst, 'VOLATILITY_AUCTION', 'VOLATILITY', expectedEnd, {
      auctionId: e.auctionId,
    });
  }

  async onAuctionIndicative(
    tx: SessionTx,
    e: {
      board: string;
      auctionId: string;
      theoreticalPrice: string | null;
      theoreticalQuantity: number;
    },
  ): Promise<void> {
    if (e.board !== 'MAIN') return;
    await tx.recordIndicative({
      auctionId: e.auctionId,
      price: e.theoreticalPrice === null ? null : new Decimal(e.theoreticalPrice),
      quantity: BigInt(e.theoreticalQuantity),
    });
  }

  /** O Motor concluiu: a referência dos túneis vira o preço do leilão (RN-INS-040, RN-AUC-020). */
  async onAuctionCompleted(
    tx: SessionTx,
    e: {
      instrumentId: string;
      board: string;
      auctionId: string;
      price: string | null;
      quantity: number;
    },
  ): Promise<void> {
    if (e.board !== 'MAIN') return;
    const m = await tx.lockMarket();
    const a = await tx.auction(e.auctionId, { forUpdate: true });
    const inst = await tx.instrument(e.instrumentId, { forUpdate: true });
    if (!a || !inst || a.status === 'COMPLETED' || a.status === 'CANCELED') return;
    a.status = 'COMPLETED';
    a.effectiveEndAt = this.now();
    a.price = e.price === null ? null : new Decimal(e.price);
    a.quantity = BigInt(e.quantity);
    await tx.saveAuction(a);
    if (a.price) inst.bandReferencePrice = a.price;
    if (inst.phase && AUCTION_PHASES.includes(inst.phase))
      await this.setInstrumentPhase(tx, m, inst, null, 'AUCTION_COMPLETED', null, {
        auctionId: a.id,
      });
    else await tx.saveInstrument(inst);
  }

  /** Último negócio do contínuo no livro principal (RN-FCH-001). */
  async onTradeExecuted(
    tx: SessionTx,
    e: {
      instrumentId: string;
      board: string;
      engineSeq: number;
      price: string;
      tradingDate: string;
      auctionId?: string;
    },
  ): Promise<void> {
    if (e.board !== 'MAIN' || e.auctionId) return;
    await tx.recordContinuousTrade({
      instrumentId: e.instrumentId,
      price: new Decimal(e.price),
      tradingDate: BusinessDate.parse(e.tradingDate),
      engineSeq: BigInt(e.engineSeq),
    });
  }

  // ------------------------------------------------------------------- suspensões (Pregão §5)

  /** Abre a suspensão; a repetição do mesmo escopo e motivo devolve a ativa, sem novo efeito. */
  async startHalt(tx: SessionTx, m: MarketState, r: HaltRequest): Promise<Halt | null> {
    const halt: Halt = {
      id: this.d.newId(),
      scope: r.scope,
      reasonCode: r.reasonCode,
      description: r.description ?? null,
      startedAt: this.now(),
      endedAt: null,
      resumeAt: r.resumeAt ?? null,
      resumeAuctionS: r.resumeAuctionS ?? DEFAULT_RESUME_AUCTION_S,
      cancelAllOnHalt: r.cancelAllOnHalt ?? false,
      actorId: r.actorId ?? SYSTEM,
      approvalRequestId: r.approvalRequestId ?? null,
    };
    const inst = r.scope === 'MARKET' ? null : await tx.instrument(r.scope, { forUpdate: true });
    if (r.scope !== 'MARKET' && !inst) return null;
    if (!(await tx.insertHalt(halt)))
      return (await tx.activeHalts(r.scope)).find((h) => h.reasonCode === r.reasonCode) ?? null;
    await tx.publish(
      {
        type: 'session.halt_started',
        payload: {
          haltId: halt.id,
          scope: halt.scope,
          reasonCode: halt.reasonCode,
          cancelAllOnHalt: halt.cancelAllOnHalt,
          resumesAt: halt.resumeAt?.toString() ?? null,
        },
      },
      halt.scope,
    );
    if (inst) {
      for (const a of await tx.liveAuctions(inst.id)) {
        a.status = 'CANCELED';
        a.effectiveEndAt = this.now();
        await tx.saveAuction(a);
      }
      await this.setInstrumentPhase(tx, m, inst, 'HALTED', halt.reasonCode, halt.resumeAt);
      return halt;
    }
    await this.cancelLiveAuctions(tx, m, halt.reasonCode);
    if (m.phase !== 'HALTED')
      await this.transitionMarket(
        tx,
        m,
        'HALTED',
        halt.reasonCode,
        halt.resumeAt,
        new Map(),
        halt.actorId,
      );
    return halt;
  }

  /** Fim de uma suspensão: sem outra ativa no escopo, retoma por leilão (RN-HLT-002). */
  async endHalt(tx: SessionTx, m: MarketState, halt: Halt): Promise<void> {
    await this.closeHalt(tx, halt, { resume: true, market: m });
  }

  private async closeHalt(
    tx: SessionTx,
    halt: Halt,
    opts: { resume: boolean; market: MarketState },
  ): Promise<void> {
    if (halt.endedAt) return;
    halt.endedAt = this.now();
    await tx.saveHalt(halt);
    await tx.publish(
      {
        type: 'session.halt_ended',
        payload: { haltId: halt.id, scope: halt.scope, reasonCode: halt.reasonCode },
      },
      halt.scope,
    );
    if (!opts.resume || (await tx.activeHalts(halt.scope)).length > 0) return;
    if (halt.scope === 'MARKET') await this.resumeMarket(tx, opts.market, halt.resumeAuctionS);
    else await this.resumeInstrument(tx, opts.market, halt.scope, halt.resumeAuctionS);
  }

  /** Volta o mercado à fase da grade, pela pré-abertura quando há negociação a retomar. */
  private async resumeMarket(tx: SessionTx, m: MarketState, auctionS: number): Promise<void> {
    const date = m.businessDate ?? this.now().businessDate();
    const scheduled = m.scheduledPhase;
    if (scheduled === 'CONTINUOUS') {
      const end = this.now().plusMillis(auctionS * 1000);
      const extras = await this.openMarketAuctions(tx, 'REOPENING', date, end);
      await this.transitionMarket(tx, m, 'PRE_OPENING', 'RESUME', end, extras);
      return;
    }
    if (scheduled === 'PRE_OPENING' || scheduled === 'CLOSING_CALL') {
      const end = this.expectedEnd(date, scheduled);
      const type: AuctionType = scheduled === 'PRE_OPENING' ? 'OPENING' : 'CLOSING';
      const extras = await this.openMarketAuctions(tx, type, date, end ?? this.now());
      await this.transitionMarket(tx, m, scheduled, 'RESUME', end, extras);
      return;
    }
    await this.transitionMarket(tx, m, scheduled, 'RESUME', this.expectedEnd(date, scheduled));
  }

  private async resumeInstrument(
    tx: SessionTx,
    m: MarketState,
    instrumentId: string,
    auctionS: number,
  ): Promise<void> {
    const inst = await tx.instrument(instrumentId, { forUpdate: true });
    if (!inst) return;
    const date = m.businessDate ?? this.now().businessDate();
    if (m.phase === 'CONTINUOUS') {
      const end = this.now().plusMillis(auctionS * 1000);
      const { auction, extras } = await this.openAuction(tx, inst, 'REOPENING', date, end, false);
      await this.setInstrumentPhase(tx, m, inst, 'PRE_OPENING', 'RESUME', end, {
        auctionId: auction.id,
        extras,
      });
      return;
    }
    if (m.phase === 'PRE_OPENING' || m.phase === 'CLOSING_CALL') {
      const type: AuctionType = m.phase === 'PRE_OPENING' ? 'OPENING' : 'CLOSING';
      const end = m.expectedEndAt ?? this.now();
      const { auction, extras } = await this.openAuction(tx, inst, type, date, end, true);
      await this.setInstrumentPhase(tx, m, inst, null, 'RESUME', null, {
        auctionId: auction.id,
        extras,
      });
      return;
    }
    await this.setInstrumentPhase(tx, m, inst, null, 'RESUME', null);
  }

  /** RN-REC-003: livro em recuperação no Motor. */
  async onBookRecovering(tx: SessionTx, instrumentId: string): Promise<void> {
    const m = await tx.lockMarket();
    await this.startHalt(tx, m, { scope: instrumentId, reasonCode: HaltReason.ENGINE_RECOVERY });
  }

  async onBookRecovered(tx: SessionTx, instrumentId: string): Promise<void> {
    await this.endHaltsByReason(tx, instrumentId, [HaltReason.ENGINE_RECOVERY]);
  }

  private async endHaltsByReason(
    tx: SessionTx,
    scope: string,
    reasons: readonly string[],
  ): Promise<void> {
    const m = await tx.lockMarket();
    for (const halt of await tx.activeHalts(scope))
      if (reasons.includes(halt.reasonCode)) await this.endHalt(tx, m, halt);
  }

  // ------------------------------------------------------------------- cópia do reference-data

  async onInstrumentState(
    tx: SessionTx,
    i: { instrumentId: string; symbol: string; tradable: boolean; status: string },
  ): Promise<void> {
    await tx.upsertInstrumentCopy({
      id: i.instrumentId,
      symbol: i.symbol,
      tradable: i.tradable && i.status !== 'DELISTED',
      status: i.status,
    });
  }

  /** RN-INS-020/021: `SUSPENDED` no cadastro suspende na sessão; a volta retoma por leilão. */
  async onStatusChanged(
    tx: SessionTx,
    e: { instrumentId: string; symbol: string; from: string; to: string; reason: string },
  ): Promise<void> {
    const m = await tx.lockMarket();
    const current = await tx.instrument(e.instrumentId, { forUpdate: true });
    await tx.upsertInstrumentCopy({
      id: e.instrumentId,
      symbol: e.symbol,
      tradable: (current?.tradable ?? false) && e.to !== 'DELISTED',
      status: e.to,
    });
    if (e.to === 'SUSPENDED') {
      await this.startHalt(tx, m, {
        scope: e.instrumentId,
        reasonCode: haltReasonOfStatus(e.reason),
        description: e.reason,
      });
      return;
    }
    if (e.from === 'SUSPENDED') {
      for (const halt of await tx.activeHalts(e.instrumentId))
        if (STATUS_HALT_REASONS.includes(halt.reasonCode)) await this.endHalt(tx, m, halt);
    }
  }

  async onTradabilityChanged(
    tx: SessionTx,
    e: { instrumentId: string; symbol: string; tradable: boolean },
  ): Promise<void> {
    const m = await tx.lockMarket();
    const current = await tx.instrument(e.instrumentId, { forUpdate: true });
    await tx.upsertInstrumentCopy({
      id: e.instrumentId,
      symbol: e.symbol,
      tradable: e.tradable,
      status: current?.status ?? 'PENDING',
    });
    const inst = (await tx.instrument(e.instrumentId))!;
    if (e.tradable) {
      await this.sendBandUpdate(tx, inst);
      const phase = effectivePhase(m.phase, inst.phase);
      if (phase !== inst.enginePhase) await this.sendPhase(tx, inst, phase);
      return;
    }
    for (const a of await tx.liveAuctions(inst.id)) await this.cancelAuction(tx, m, a, 'REMOVED');
    const fresh = (await tx.instrument(inst.id))!;
    await this.sendPhase(tx, fresh, 'CLOSED');
  }

  async onTradingRulesChanged(
    tx: SessionTx,
    e: {
      ruleId: string;
      instrumentId: string | null;
      rules: Partial<SessionRules>;
      validFrom: Instant;
    },
  ): Promise<void> {
    await tx.insertRuleVersion(e);
    if (e.validFrom.isAfter(this.now())) return; // vigência futura: vale na abertura (07:00)
    const instruments = e.instrumentId
      ? [await tx.instrument(e.instrumentId)]
      : await tx.tradableInstruments();
    for (const i of instruments) if (i?.tradable) await this.sendBandUpdate(tx, i);
  }

  // ------------------------------------------------------------------- Market Data

  /** Leitura externa de um instrumento: semente do fechamento e fechamento externo (RN-FCH-003). */
  async onInstrumentQuote(
    tx: SessionTx,
    q: {
      instrumentId: string;
      lastPrice: string;
      previousClose: string | null;
      quoteTime: Instant;
    },
  ): Promise<void> {
    await this.heartbeat(tx);
    const inst = await tx.instrument(q.instrumentId, { forUpdate: true });
    if (!inst) return;
    if (!inst.externalQuoteTime || !q.quoteTime.isBefore(inst.externalQuoteTime)) {
      inst.externalPrice = new Decimal(q.lastPrice);
      inst.externalQuoteTime = q.quoteTime;
    }
    // Sem fechamento interno ainda: o externo é a primeira referência dos túneis.
    if (!inst.previousClose) {
      const seed = new Decimal(q.previousClose ?? q.lastPrice);
      inst.previousClose = seed;
      inst.bandReferencePrice = inst.bandReferencePrice ?? seed;
      if (inst.tradable) await this.sendBandUpdate(tx, inst);
    }
    await tx.saveInstrument(inst);
    await this.checkDivergence(tx, inst, q.quoteTime.businessDate());
  }

  /** Atividade do Market Data; se ele tinha sumido, retoma por leilão (Pregão §5). */
  async heartbeat(tx: SessionTx): Promise<void> {
    const halts = await tx.activeHalts('MARKET');
    if (halts.some((h) => h.reasonCode === HaltReason.MARKET_DATA_UNAVAILABLE)) {
      await this.endHaltsByReason(tx, 'MARKET', [HaltReason.MARKET_DATA_UNAVAILABLE]);
    }
    await tx.touchMarketData(this.now());
  }

  // ------------------------------------------------------------------- circuit breaker (§6)

  /** Leitura do Ibovespa externo: compara ao fechamento anterior (RN-MD-021). */
  async onIndexQuote(
    tx: SessionTx,
    q: { lastPrice: string; previousClose: string | null; quoteTime: Instant; stale: boolean },
  ): Promise<void> {
    // Trava o mercado antes de tocar em `market_watch`: a mesma ordem da vigilância e da retomada.
    const m = await tx.lockMarket();
    await this.heartbeat(tx);
    if (!q.previousClose) return;
    const last = new Decimal(q.lastPrice);
    const previousClose = new Decimal(q.previousClose);
    await tx.saveIndex({ last, previousClose, quoteTime: q.quoteTime });
    const now = this.now();
    if (q.stale || !q.quoteTime.businessDate().equals(now.businessDate())) return;
    if (!this.continuousTrading(m)) return;
    const window = this.continuousWindow(now.businessDate());
    if (!window) return;
    const date = m.businessDate ?? now.businessDate();
    const change = indexChange(last, previousClose);
    const level = evaluateCircuitBreaker({
      change,
      triggered: (await tx.circuitBreakerEvents(date)).map((e) => e.level),
      now,
      continuousEndsAt: window,
      blackoutMinutes: this.d.params.circuitBreakerBlackoutMinutes,
    });
    if (level) await this.triggerCircuitBreaker(tx, m, level, 'INDEX', change);
  }

  /** O nível seguinte só vale depois da retomada do anterior: o mercado volta ao contínuo antes. */
  continuousTrading(m: MarketState): boolean {
    return m.phase === 'CONTINUOUS' && m.scheduledPhase === 'CONTINUOUS';
  }

  private continuousWindow(date: BusinessDate): Instant | null {
    try {
      return (
        this.d.calendar.sessionSchedule(date)?.phases.find((w) => w.phase === 'CONTINUOUS')
          ?.endsAt ?? null
      );
    } catch (err) {
      if (err instanceof CalendarNotLoadedError) return null;
      throw err;
    }
  }

  /** RN-CB-001/004: um evento por nível e dia, todos os instrumentos em `HALTED`. */
  async triggerCircuitBreaker(
    tx: SessionTx,
    m: MarketState,
    level: CircuitBreakerLevel,
    origin: 'INDEX' | 'BACKOFFICE' | 'SANDBOX',
    change: Decimal | null,
    opts: { actorId?: string; approvalRequestId?: string } = {},
  ): Promise<void> {
    const now = this.now();
    const date = m.businessDate ?? now.businessDate();
    const seconds = CIRCUIT_BREAKER_LEVELS[level].haltSeconds;
    const resumeAt = seconds === null ? null : now.plusMillis(seconds * 1000);
    // Nível 3: padrão até o fim do pregão, quando o `post_close` encerra a suspensão.
    const resumesAt =
      resumeAt ??
      this.d.calendar.sessionSchedule(date)?.phases.find((w) => w.phase === 'POST_CLOSE')
        ?.startsAt ??
      now;
    await tx.insertCircuitBreaker({
      id: this.d.newId(),
      businessDate: date,
      level,
      indexChange: change,
      origin,
      triggeredAt: now,
      resumesAt,
    });
    await tx.publish(
      {
        type: 'session.circuit_breaker_triggered',
        payload: {
          level,
          indexChangePercent: change?.toFixed(8) ?? null,
          resumesAt: resumesAt.toString(),
          origin,
        },
      },
      'MARKET',
    );
    await this.startHalt(tx, m, {
      scope: 'MARKET',
      reasonCode: circuitBreakerReason(level),
      resumeAt,
      resumeAuctionS: CIRCUIT_BREAKER_RESUME_AUCTION_S,
      ...(opts.actorId ? { actorId: opts.actorId } : {}),
      ...(opts.approvalRequestId ? { approvalRequestId: opts.approvalRequestId } : {}),
    });
  }

  // ------------------------------------------------------------------- fechamento (§9)

  /** RN-FCH-001/002: define o fechamento do dia, que vira a referência do pregão seguinte. */
  private async defineClosingPrices(tx: SessionTx, date: BusinessDate): Promise<void> {
    for (const inst of await tx.tradableInstruments()) {
      const call = await tx.completedClosingCall(inst.id, date);
      const close = closingPrice({
        closingCall: call && (call.quantity ?? 0n) > 0n ? call.price : null,
        lastContinuousTrade: inst.lastTradeDate?.equals(date) ? inst.lastTradePrice : null,
        previousClose: inst.previousClose,
      });
      if (!close) continue;
      await tx.upsertClosingPrice({
        instrumentId: inst.id,
        businessDate: date,
        price: close.price,
        source: close.source,
        externalClose: null,
        divergenceAlert: false,
      });
      inst.previousClose = close.price;
      inst.bandReferencePrice = close.price;
      await tx.saveInstrument(inst);
      await this.checkDivergence(tx, inst, date);
    }
  }

  /** RN-FCH-003: confere ao fechar e de novo a cada leitura do dia (ex.: a das 18:00). */
  private async checkDivergence(
    tx: SessionTx,
    inst: InstrumentState,
    date: BusinessDate,
  ): Promise<void> {
    const close = await tx.closingPrice(inst.id, date);
    if (!close || !inst.externalPrice || !inst.externalQuoteTime?.businessDate().equals(date))
      return;
    close.externalClose = inst.externalPrice;
    const limit = new Decimal(this.d.params.closeDivergenceAlertPct);
    if (!close.divergenceAlert && closeDiverges(close.price, inst.externalPrice, limit)) {
      close.divergenceAlert = true;
      await this.alert(
        tx,
        'CLOSE_DIVERGENCE',
        `CLOSE_DIVERGENCE:${inst.id}:${date.toString()}`,
        `Fechamento de ${inst.symbol} diverge do externo em mais de ${limit.times(100).toFixed()}%.`,
        {
          instrumentId: inst.id,
          symbol: inst.symbol,
          businessDate: date.toString(),
          internalClose: close.price.toFixed(),
          externalClose: inst.externalPrice.toFixed(),
        },
      );
    }
    await tx.upsertClosingPrice(close);
  }

  private async alert(
    tx: SessionTx,
    kind: string,
    dedupeKey: string,
    message: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const created = await tx.insertAlert({
      id: this.d.newId(),
      kind,
      dedupeKey,
      message,
      data,
      createdAt: this.now(),
    });
    if (created) this.d.logger.warn({ event: 'session.alert', kind, ...data }, message);
  }

  // ------------------------------------------------------------------- laço do líder

  /** Prazos que vencem com o tempo: retomadas, leilões do instrumento e a vigilância do Market Data. */
  async tick(): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      const m = await tx.lockMarket();
      const now = this.now();
      for (const halt of await tx.activeHalts())
        if (halt.resumeAt && !halt.resumeAt.isAfter(now)) await this.endHalt(tx, m, halt);
      if (
        m.phase === 'PRE_OPENING' &&
        m.scheduledPhase !== 'PRE_OPENING' &&
        m.expectedEndAt &&
        !m.expectedEndAt.isAfter(now)
      ) {
        await this.settleMarketAuctions(tx, m, m.scheduledPhase);
        await this.transitionMarket(
          tx,
          m,
          m.scheduledPhase,
          'REOPENING_COMPLETED',
          m.businessDate ? this.expectedEnd(m.businessDate, m.scheduledPhase) : null,
        );
      }
      let closingDecided = false;
      for (const a of await tx.liveAuctions()) {
        if (a.marketScoped || a.status !== 'OPEN' || a.expectedEndAt.isAfter(now)) continue;
        const closing = a.type === 'CLOSING';
        const concluded = await this.decideAuction(tx, m, a, closing ? 'POST_CLOSE' : m.phase);
        if (concluded && closing) {
          closingDecided = true;
          const inst = await tx.instrument(a.instrumentId);
          if (inst) await this.setInstrumentPhase(tx, m, inst, 'POST_CLOSE', 'SCHEDULE', null);
        }
      }
      if (closingDecided) await this.finishPostClose(tx, m);
      await this.watchMarketData(tx, m, now);
    });
  }

  /** Pregão §5: Market Data mudo por mais de N minutos no contínuo. */
  private async watchMarketData(tx: SessionTx, m: MarketState, now: Instant): Promise<void> {
    const minutes = this.d.params.marketDataOutageMinutes;
    if (minutes <= 0 || !this.continuousTrading(m)) return;
    const watch = await tx.watch();
    // Em economia de cota as leituras rareiam de propósito (Brapi §5.3): silêncio não é falha.
    if (watch.budgetLevel !== 'NORMAL') return;
    const last =
      watch.lastMarketDataAt && watch.lastMarketDataAt.isAfter(m.since)
        ? watch.lastMarketDataAt
        : m.since;
    if (last.plusMillis(minutes * 60_000).isAfter(now)) return;
    if ((await tx.tradableInstruments()).length === 0) return;
    await this.startHalt(tx, m, {
      scope: 'MARKET',
      reasonCode: HaltReason.MARKET_DATA_UNAVAILABLE,
    });
  }
}

export function bandUpdate(
  instrumentId: string,
  price: Decimal,
  rules: SessionRules,
): Extract<SessionEvent, { type: 'engine.band_update' }> {
  return {
    type: 'engine.band_update',
    payload: {
      instrumentId,
      bandReferencePrice: price.toFixed(),
      rejectionBandPct: rules.rejectionBandPct,
      staticAuctionBandPct: rules.staticAuctionBandPct,
      dynamicAuctionBandPct: rules.dynamicAuctionBandPct,
      volatilityAuctionDurationS: rules.volatilityAuctionDurationS,
      auctionRandomEndMaxS: rules.auctionRandomEndMaxS,
    },
  };
}
