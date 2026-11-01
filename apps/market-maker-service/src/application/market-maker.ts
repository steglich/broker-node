import { Decimal, Instant } from '@broker/domain-kernel';
import { effectivePhase, quoteMode, type Phase } from '../domain/phases.js';
import { applyFill, unrealizedPnl, type Side } from '../domain/position.js';
import {
  computeQuotes,
  diffQuotes,
  effectiveSpreadBps,
  planSweep,
  stalenessMultiplier,
  type ClientLevel,
  type LiveOrder,
  type QuoteLevel,
} from '../domain/quotes.js';
import type { SmmParams } from '../domain/params.js';
import { SYSTEM, type SmmDeps } from './context.js';
import type { Control, InstrumentState, SmmTx } from './ports.js';
import { resolveFills } from './replay.js';

const PARTICIPANT = 'MARKET_MAKER';
const CANCEL_REASON = 'SMM_REQUOTE';

/**
 * O FMS (Motor §6): mantém as ofertas do instrumento coerentes com a referência, o inventário, a
 * fase e o kill switch. Toda mudança passa por `requote`, com a linha do instrumento travada, e sai
 * pela outbox: os cancelamentos antes das novas ordens, na mesma partição de `engine.commands`, o
 * que garante que as ofertas antigas saem do livro antes das novas entrarem (RN-SMM-011).
 */
export class MarketMaker {
  constructor(private readonly d: SmmDeps) {}

  private now(): Instant {
    return this.d.clock.now();
  }

  // ------------------------------------------------------------------- cadastro

  /** `instrument.created`/`updated`: a cópia local traz lote, tick e o universo (RN-INS-014). */
  async onInstrumentState(
    tx: SmmTx,
    p: {
      instrumentId: string;
      symbol: string;
      lotSize: number;
      tickSize: string;
      oddLotEnabled: boolean;
      tradable: boolean;
      status: string;
    },
  ): Promise<void> {
    const i = await tx.lockInstrument(p.instrumentId);
    i.symbol = p.symbol;
    i.lotSize = p.lotSize;
    i.tickSize = new Decimal(p.tickSize);
    i.oddLot = p.oddLotEnabled;
    i.tradable = p.tradable;
    i.status = p.status;
    await this.activateIfNeeded(tx, i);
    await this.requote(tx, i);
  }

  async onTradabilityChanged(
    tx: SmmTx,
    p: { instrumentId: string; symbol: string; lotSize: number; tradable: boolean },
  ): Promise<void> {
    const i = await tx.lockInstrument(p.instrumentId);
    i.symbol = p.symbol;
    i.lotSize = p.lotSize;
    i.tradable = p.tradable;
    await this.activateIfNeeded(tx, i);
    await this.requote(tx, i);
  }

  async onStatusChanged(tx: SmmTx, p: { instrumentId: string; to: string }): Promise<void> {
    const i = await tx.lockInstrument(p.instrumentId);
    i.status = p.to;
    await this.requote(tx, i);
  }

  /** O spread é do reference-data (Ativos §7); entra na próxima recotação, como os demais parâmetros. */
  async onTradingRulesChanged(
    tx: SmmTx,
    p: {
      ruleId: string;
      instrumentId: string | null;
      rules: { smmSpreadBps?: number };
      validFrom: Instant;
    },
  ): Promise<void> {
    if (p.rules.smmSpreadBps === undefined) return;
    await tx.insertParams({
      id: p.ruleId,
      instrumentId: p.instrumentId,
      params: { spreadBps: p.rules.smmSpreadBps },
      validFrom: p.validFrom,
      approvalRequestId: null,
    });
  }

  /**
   * RN-SMM-020: o estoque nasce uma vez só, ao entrar no universo. Voltar depois de sair não emite de
   * novo. A custódia aplica `ISSUER_SECURITIES` → `SMM_SECURITIES` a partir deste evento na Fase 3.
   */
  private async activateIfNeeded(tx: SmmTx, i: InstrumentState): Promise<void> {
    if (i.activatedAt || !i.tradable || !i.symbol || !i.lotSize) return;
    const now = this.now();
    const params = await tx.paramsAt(i.id, now);
    i.activatedAt = now;
    i.initialStock = params.inventoryLimitLots * i.lotSize;
    await tx.publish(
      {
        type: 'smm.instrument_activated',
        payload: {
          instrumentId: i.id,
          symbol: i.symbol,
          accountId: this.d.accountId,
          initialStock: i.initialStock,
          activatedAt: now.toString(),
        },
      },
      i.id,
    );
  }

  // ------------------------------------------------------------------- referência

  async onReferencePrice(
    tx: SmmTx,
    p: { instrumentId: string; seq: number; price: string; externalQuoteTime: Instant | null },
  ): Promise<void> {
    const i = await tx.lockInstrument(p.instrumentId);
    if (p.seq <= i.referenceSeq) return;
    i.referenceSeq = p.seq;
    i.reference = new Decimal(p.price);
    i.externalQuoteTime = p.externalQuoteTime;
    // O glide e o ruído continuam sem a brapi: só uma cotação externa mais nova encerra a defasagem.
    const fresh =
      i.staleSince !== null &&
      p.externalQuoteTime !== null &&
      p.externalQuoteTime.isAfter(i.staleSince);
    if (fresh) {
      i.staleSince = null;
      i.staleAt = null;
    }
    const params = await tx.paramsAt(i.id, this.now());
    if (fresh || this.movedPastThreshold(i, params)) await this.requote(tx, i);
    else await tx.saveInstrument(i);
  }

  /** RN-SMM-010(a): mudou mais que `smm_requote_threshold_ticks`, ou nunca cotou. */
  private movedPastThreshold(i: InstrumentState, params: SmmParams): boolean {
    if (!i.reference) return false;
    if (!i.lastReference || !i.tickSize) return true;
    return i.reference
      .minus(i.lastReference)
      .abs()
      .greaterThan(i.tickSize.times(params.requoteThresholdTicks));
  }

  /** RN-BRP-070: a defasagem é do Market Data; o alargamento conta a partir de quando ele a declarou. */
  async onInstrumentStale(
    tx: SmmTx,
    p: { instrumentId: string; staleSince: Instant; declaredAt: Instant },
  ): Promise<void> {
    const i = await tx.lockInstrument(p.instrumentId);
    if (i.externalQuoteTime?.isAfter(p.staleSince)) return;
    i.staleSince = p.staleSince;
    i.staleAt ??= p.declaredAt;
    await tx.saveInstrument(i);
  }

  async onBandUpdate(
    tx: SmmTx,
    p: { instrumentId: string; bandReferencePrice: string; rejectionBandPct: string },
  ): Promise<void> {
    const i = await tx.lockInstrument(p.instrumentId);
    i.bandReference = new Decimal(p.bandReferencePrice);
    i.rejectionBandPct = new Decimal(p.rejectionBandPct);
    await tx.saveInstrument(i);
  }

  /** RN-INS-040: um leilão concluído com negócio move o túnel no Motor, sem novo `BandUpdate`. */
  async onAuctionCompleted(
    tx: SmmTx,
    p: { instrumentId: string; board: string; price: string | null },
  ): Promise<void> {
    if (p.board !== 'MAIN' || p.price === null) return;
    const i = await tx.lockInstrument(p.instrumentId);
    i.bandReference = new Decimal(p.price);
    await tx.saveInstrument(i);
  }

  // ------------------------------------------------------------------- fases

  /**
   * RN-SES-002: `scope = MARKET` vale para quem segue o mercado; quem tem fase própria recebe também
   * o evento do instrumento quando a efetiva muda. A fase própria igual à do mercado é descartada:
   * a sessão só volta a avisar se a efetiva divergir, e a mais restritiva cobre a chegada fora de
   * ordem entre as partições.
   */
  async onPhaseChanged(tx: SmmTx, p: { scope: string; to: Phase }): Promise<void> {
    if (p.scope === 'MARKET') {
      const c = await tx.lockControl();
      if (c.marketPhase === p.to) return;
      const before = c.marketPhase;
      c.marketPhase = p.to;
      await tx.saveControl(c);
      for (const id of await tx.instrumentIds()) {
        const i = await tx.lockInstrument(id);
        const was = effectivePhase(before, i.ownPhase);
        if (i.ownPhase === p.to) i.ownPhase = null;
        if (effectivePhase(p.to, i.ownPhase) !== was) await this.requote(tx, i);
        else await tx.saveInstrument(i);
      }
      return;
    }
    const c = await tx.control();
    const i = await tx.lockInstrument(p.scope);
    const was = effectivePhase(c.marketPhase, i.ownPhase);
    i.ownPhase = p.to === c.marketPhase ? null : p.to;
    if (effectivePhase(c.marketPhase, i.ownPhase) !== was) await this.requote(tx, i);
    else await tx.saveInstrument(i);
  }

  // ------------------------------------------------------------------- saídas do Motor

  async onOrderBooked(
    tx: SmmTx,
    p: { instrumentId: string; orderId: string; remainingQuantity: number },
  ): Promise<void> {
    const i = await tx.lockInstrument(p.instrumentId);
    const order = i.liveOrders.find((o) => o.orderId === p.orderId);
    if (!order) return;
    order.remaining = p.remainingQuantity;
    if (order.status === 'SENT') order.status = 'BOOKED';
    await tx.saveInstrument(i);
  }

  /** Cancelada ou rejeitada, por comando ou regra: em qualquer caso a oferta saiu. */
  async onOrderGone(tx: SmmTx, p: { instrumentId: string; orderId: string }): Promise<void> {
    const i = await tx.lockInstrument(p.instrumentId);
    const left = i.liveOrders.filter((o) => o.orderId !== p.orderId);
    if (left.length === i.liveOrders.length) return;
    i.liveOrders = left;
    await tx.saveInstrument(i);
  }

  async onBookChanged(
    tx: SmmTx,
    p: {
      instrumentId: string;
      board: string;
      engineSeq: number;
      side: Side;
      price: string;
      newQuantity: number;
    },
  ): Promise<void> {
    if (p.board !== 'MAIN') return;
    await tx.applyBookChange({
      instrumentId: p.instrumentId,
      engineSeq: p.engineSeq,
      side: p.side,
      price: new Decimal(p.price),
      quantity: p.newQuantity,
    });
  }

  /** RN-SMM-010(b): o nível totalmente executado volta na recotação. A varredura não é nível. */
  async onTradeExecuted(
    tx: SmmTx,
    p: {
      instrumentId: string;
      engineSeq: number;
      tradeId: string;
      price: string;
      quantity: number;
      buyOrderId: string;
      sellOrderId: string;
      buyAccountId: string;
      sellAccountId: string;
      buyParticipantType: string;
      sellParticipantType: string;
      executedAt: string;
    },
  ): Promise<void> {
    const mine = (participant: string, account: string) =>
      participant === PARTICIPANT && account === this.d.accountId;
    const sides: { side: Side; orderId: string }[] = [];
    if (mine(p.buyParticipantType, p.buyAccountId))
      sides.push({ side: 'BUY', orderId: p.buyOrderId });
    if (mine(p.sellParticipantType, p.sellAccountId))
      sides.push({ side: 'SELL', orderId: p.sellOrderId });
    if (sides.length === 0) return;

    const i = await tx.lockInstrument(p.instrumentId);
    const price = new Decimal(p.price);
    let levelExecuted = false;
    for (const { side, orderId } of sides) {
      const fresh = await tx.insertFill({
        tradeId: p.tradeId,
        side,
        instrumentId: p.instrumentId,
        quantity: p.quantity,
        price,
        engineSeq: p.engineSeq,
        executedAt: Instant.parse(p.executedAt),
      });
      if (!fresh) continue;
      i.position = applyFill(i.position, side, p.quantity, price);
      const order = i.liveOrders.find((o) => o.orderId === orderId);
      if (!order) continue;
      order.remaining -= p.quantity;
      if (order.remaining > 0) continue;
      i.liveOrders = i.liveOrders.filter((o) => o.orderId !== orderId);
      if (!order.sweep) levelExecuted = true;
    }
    if (levelExecuted) await this.requote(tx, i);
    else await tx.saveInstrument(i);
  }

  /** RN-BST-002: o negócio cancelado sai do inventário e do resultado, refeitos pelas pontas vivas. */
  async onTradeBusted(tx: SmmTx, p: { instrumentId: string; tradeId: string }): Promise<void> {
    const i = await tx.lockInstrument(p.instrumentId);
    if (!(await tx.bustFills(p.tradeId))) return;
    i.position = resolveFills(await tx.fills(i.id));
    await this.requote(tx, i);
  }

  // ------------------------------------------------------------------- recotação

  /** Laço do líder: manutenção de RN-SMM-010(d), degraus de RN-SMM-032 e `smm.metrics`. */
  async tick(): Promise<void> {
    const ids = await this.d.store.transaction((tx) => tx.instrumentIds());
    for (const id of ids) {
      await this.d.store.transaction(async (tx) => {
        const i = await tx.lockInstrument(id);
        const now = this.now();
        const params = await tx.paramsAt(id, now);
        const due =
          !i.lastRequoteAt ||
          now.epochMillis - i.lastRequoteAt.epochMillis >= params.refreshIntervalS * 1000;
        const widened = this.multiplier(i, now) !== (i.stopped ? null : i.spreadMultiplier);
        if (!due && !widened) return;
        await this.requote(tx, i);
        // Fora de pregão não há o que medir: sem oferta nem tempo cotado, o tópico fica quieto.
        if (due && (i.quotedSince || i.liveOrders.length > 0))
          await tx.publish({ type: 'smm.metrics', payload: metricsView(i, now) }, id);
      });
    }
  }

  private multiplier(i: InstrumentState, now: Instant): number | null {
    return stalenessMultiplier(i.staleAt ? now.epochMillis - i.staleAt.epochMillis : null);
  }

  /** Recalcula, manda a diferença ao Motor e grava o estado. Exige a linha do instrumento travada. */
  async requote(tx: SmmTx, i: InstrumentState): Promise<void> {
    const now = this.now();
    const control = await tx.control();
    const phase = effectivePhase(control.marketPhase, i.ownPhase);
    const mode = quoteMode(phase);
    const multiplier = this.multiplier(i, now);
    const stopped = multiplier === null;

    let planned: QuoteLevel[] = [];
    let sweep: ReturnType<typeof planSweep>['sweep'] = null;
    if (this.canQuote(i, control) && !stopped && mode !== 'NONE') {
      const params = await this.effectiveParams(tx, i, now);
      planned = computeQuotes({
        reference: i.reference!,
        tick: i.tickSize!,
        lotSize: i.lotSize!,
        inventory: i.position.inventory,
        params,
        single: mode !== 'FULL',
        spreadMultiplier: multiplier,
        band: this.band(i),
        oddLot: i.oddLot,
      });
      if (mode === 'FULL') {
        const plan = planSweep(planned, await this.clientLevels(tx, i), {
          inventory: i.position.inventory,
          lotSize: i.lotSize!,
          params,
        });
        planned = plan.quotes;
        sweep = plan.sweep;
      }
    }
    // Motor §6.6: em `PRE_TRADING` a conta fica visível, mas nada vai ao livro.
    const desired = mode === 'PLAN' ? [] : planned;
    const diff = diffQuotes(i.liveOrders, desired);
    for (const order of diff.cancel) {
      order.status = 'CANCELING';
      await tx.publish(
        {
          type: 'engine.cancel_order',
          payload: { instrumentId: i.id, orderId: order.orderId, reason: CANCEL_REASON },
        },
        i.id,
      );
    }
    if (sweep)
      await this.place(tx, i, {
        board: 'MAIN',
        side: sweep.side,
        price: sweep.price,
        quantity: sweep.quantity,
        timeInForce: 'IOC',
      });
    for (const q of diff.place) await this.place(tx, i, { ...q, timeInForce: 'DAY' });

    await this.reportStopped(tx, i, stopped);
    this.recordQuote(i, planned, desired, now);
    i.spreadMultiplier = multiplier ?? i.spreadMultiplier;
    i.lastRequoteAt = now;
    if (planned.length > 0) i.lastReference = i.reference;
    if (desired.length > 0 || sweep) i.requotes += 1;
    await tx.saveInstrument(i);
  }

  private canQuote(i: InstrumentState, c: Control): boolean {
    return (
      c.globalEnabled &&
      i.enabled &&
      i.tradable &&
      i.status === 'ACTIVE' &&
      i.reference !== null &&
      i.tickSize !== null &&
      i.lotSize !== null &&
      i.initialStock > 0
    );
  }

  /** O limite não passa do estoque emitido: subir o parâmetro depois não cria ações (RN-SMM-021). */
  private async effectiveParams(tx: SmmTx, i: InstrumentState, now: Instant): Promise<SmmParams> {
    const params = await tx.paramsAt(i.id, now);
    const stockLots = Math.floor(i.initialStock / i.lotSize!);
    return { ...params, inventoryLimitLots: Math.min(params.inventoryLimitLots, stockLots) };
  }

  private band(i: InstrumentState) {
    if (!i.bandReference || !i.rejectionBandPct) return null;
    return {
      low: i.bandReference.times(new Decimal(1).minus(i.rejectionBandPct)),
      high: i.bandReference.times(new Decimal(1).plus(i.rejectionBandPct)),
    };
  }

  /** O livro do Motor sem o próprio FMS: as ofertas `SENT` ainda não estão nos níveis recebidos. */
  private async clientLevels(tx: SmmTx, i: InstrumentState): Promise<ClientLevel[]> {
    const own = new Map<string, number>();
    for (const o of i.liveOrders)
      if (o.board === 'MAIN' && o.status !== 'SENT') {
        const key = `${o.side}|${o.price}`;
        own.set(key, (own.get(key) ?? 0) + o.remaining);
      }
    const levels: ClientLevel[] = [];
    for (const l of await tx.bookLevels(i.id)) {
      const quantity = l.quantity - (own.get(`${l.side}|${l.price.toFixed()}`) ?? 0);
      if (quantity > 0) levels.push({ side: l.side, price: l.price, quantity });
    }
    return levels;
  }

  private async place(
    tx: SmmTx,
    i: InstrumentState,
    o: Pick<QuoteLevel, 'board' | 'side' | 'price' | 'quantity'> & {
      timeInForce: 'DAY' | 'IOC';
    },
  ): Promise<void> {
    const orderId = this.d.newId();
    const live: LiveOrder = {
      orderId,
      board: o.board,
      side: o.side,
      price: o.price.toFixed(),
      remaining: o.quantity,
      status: 'SENT',
      sweep: o.timeInForce === 'IOC',
    };
    i.liveOrders.push(live);
    await tx.publish(
      {
        type: 'engine.new_order',
        payload: {
          instrumentId: i.id,
          orderId,
          accountId: this.d.accountId,
          participantType: PARTICIPANT,
          board: o.board,
          side: o.side,
          type: 'LIMIT',
          quantity: o.quantity,
          limitPrice: live.price,
          timeInForce: o.timeInForce,
          stpPolicy: 'CANCEL_AGGRESSOR',
        },
      },
      i.id,
    );
  }

  /** RN-SMM-032: parar e voltar a cotar por defasagem aparece em `smm.status_changed`. */
  private async reportStopped(tx: SmmTx, i: InstrumentState, stopped: boolean): Promise<void> {
    if (i.stopped === stopped) return;
    i.stopped = stopped;
    await tx.publish(
      {
        type: 'smm.status_changed',
        payload: {
          scope: i.id,
          status: stopped ? 'STOPPED' : 'ON',
          reason: stopped ? 'STALE_REFERENCE_PRICE' : 'REFERENCE_PRICE_RESTORED',
          actorId: SYSTEM,
          approvalRequestId: null,
        },
      },
      i.id,
    );
  }

  /** Melhor preço calculado e o tempo com oferta ativa (RN-SMM-031). */
  private recordQuote(
    i: InstrumentState,
    planned: readonly QuoteLevel[],
    desired: readonly QuoteLevel[],
    now: Instant,
  ): void {
    const best = (side: Side) =>
      planned.find((q) => q.board === 'MAIN' && q.side === side)?.price ?? null;
    i.bestBid = best('BUY');
    i.bestAsk = best('SELL');
    if (i.quotedSince) i.quotedMs += now.epochMillis - i.quotedSince.epochMillis;
    i.quotedSince = desired.length > 0 ? now : null;
  }
}

/** Inventário, resultado e spread efetivo atuais (RN-SMM-031): o evento e o painel usam o mesmo cálculo. */
export function metricsView(i: InstrumentState, now: Instant) {
  const quotedMs = i.quotedMs + (i.quotedSince ? now.epochMillis - i.quotedSince.epochMillis : 0);
  return {
    instrumentId: i.id,
    inventory: i.position.inventory,
    realizedPnl: i.position.realizedPnl.toFixed(),
    unrealizedPnl: i.reference ? unrealizedPnl(i.position, i.reference).toFixed() : null,
    volume: i.position.volume,
    requotes: i.requotes,
    effectiveSpreadBps: effectiveSpreadBps(i.bestBid, i.bestAsk)?.toFixed() ?? null,
    quotedSeconds: Math.floor(quotedMs / 1000),
    bestBid: i.bestBid?.toFixed() ?? null,
    bestAsk: i.bestAsk?.toFixed() ?? null,
    at: now.toString(),
  };
}
