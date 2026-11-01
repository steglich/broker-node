import { Instant } from '@broker/domain-kernel';
import { theoreticalPrice, type PriceBounds } from './auction.js';
import {
  Book,
  isMarketLevel,
  type Board,
  type OrderType,
  type Participant,
  type RestingOrder,
  type Side,
  type StpPolicy,
  type TimeInForce,
} from './book.js';
import { deterministicId, hash32, IdKind, randomEndOffset } from './deterministic.js';
import type {
  AuctionType,
  BandUpdateCommand,
  EngineInput,
  EngineOutput,
  NewOrderCommand,
  Phase,
  PhaseChangeCommand,
  ReplaceOrderCommand,
  TradeBustCommand,
} from './inputs.js';
import {
  bandAround,
  formatPrice,
  insideBand,
  MARKET_BUY,
  MARKET_SELL,
  parsePrice,
  parseRate,
  type BandLimits,
  type IntPrice,
} from './price.js';

interface Bands {
  reference: IntPrice;
  rejectionRate: string;
  staticRate: string;
  dynamicRate: string;
  rejection: BandLimits;
  static: BandLimits;
  dynamic: bigint;
  volatilityDurationMs: number;
  randomEndMaxMs: number;
}

interface Auction {
  id: string;
  type: AuctionType;
  expectedEnd: number;
  seed: number;
  /** Instante sorteado do fim efetivo; `null` até a sessão mandar concluir (RN-AUC-033). */
  concludeAt: number | null;
  target: Phase;
  bounds: PriceBounds | null;
}

const AUCTION_PHASES: readonly Phase[] = ['PRE_OPENING', 'CLOSING_CALL', 'VOLATILITY_AUCTION'];
const isAuctionPhase = (phase: Phase) => AUCTION_PHASES.includes(phase);
/** Fases em que há livro ao vivo; fora delas não há o que suspender na recuperação. */
const OFF_HOURS: readonly Phase[] = ['CLOSED', 'PRE_TRADING', 'POST_CLOSE', 'AFTER_MARKET'];

const BOARDS: readonly Board[] = ['MAIN', 'ODD_LOT'];

const iso = (ms: number) => Instant.ofEpochMillis(ms).toString();

/**
 * Estado de um instrumento no Motor: os dois livros e a fase, processados por um único fluxo
 * (RN-ME-001, RN-ME-005). `process` é uma função pura da entrada e do estado: sem relógio, sem
 * acaso e sem nada assíncrono (RN-ME-002).
 *
 * O leilão é do instrumento, porque a fase é do instrumento: enquanto um quadro acumula, o outro
 * também. Cada quadro apura o próprio preço na conclusão, e só o `MAIN` move a referência dos túneis.
 */
export class InstrumentEngine {
  private readonly hash: number;
  private readonly books: Record<Board, Book> = {
    MAIN: new Book('MAIN'),
    ODD_LOT: new Book('ODD_LOT'),
  };
  private readonly dynamicBands: Record<Board, BandLimits | null> = { MAIN: null, ODD_LOT: null };
  private phaseNow: Phase = 'CLOSED';
  private bands: Bands | null = null;
  private auction: Auction | null = null;
  /** `order_id` já vistos no pregão (`DUPLICATE_ORDER_ID`). */
  private seen = new Set<string>();
  /** Negócios do pregão, para o trade bust (RN-BST-001). */
  private trades = new Map<string, { board: Board; busted: boolean }>();
  private notesCutoff: string | null = null;
  private lastInputSeq = 0;

  // Contexto da entrada em processamento.
  private input!: EngineInput;
  private now = 0;
  private outputs: EngineOutput[] = [];
  private readonly dirty: Record<Board, Record<Side, Set<IntPrice>>> = {
    MAIN: { BUY: new Set(), SELL: new Set() },
    ODD_LOT: { BUY: new Set(), SELL: new Set() },
  };
  private readonly changed: Record<Board, boolean> = { MAIN: false, ODD_LOT: false };

  constructor(readonly instrumentId: string) {
    this.hash = hash32(instrumentId);
  }

  get phase(): Phase {
    return this.phaseNow;
  }

  get inputSeq(): number {
    return this.lastInputSeq;
  }

  /** Próximo instante em que o tempo, sozinho, muda algo: o sequenciador manda um `Tick` nele. */
  nextDeadline(): number | null {
    return this.auction?.concludeAt ?? null;
  }

  /** Processa uma entrada e devolve as saídas, com `engine_seq` contínuo por livro. */
  process(input: EngineInput): EngineOutput[] {
    if (input.inputSeq !== this.lastInputSeq + 1)
      throw new Error(
        `input_seq ${input.inputSeq} fora de ordem em ${this.instrumentId} (último: ${this.lastInputSeq})`,
      );
    this.lastInputSeq = input.inputSeq;
    this.input = input;
    this.now = input.ts;
    this.outputs = [];
    this.settleDueAuction();
    const c = input.command;
    switch (c.kind) {
      case 'NewOrder':
        this.newOrder(c);
        break;
      case 'CancelOrder':
        this.cancelCommand(c.orderId, c.reason);
        break;
      case 'ReplaceOrder':
        this.replaceOrder(c);
        break;
      case 'PhaseChange':
        this.phaseChange(c);
        break;
      case 'BandUpdate':
        this.bandUpdate(c);
        break;
      case 'TradeBust':
        this.tradeBust(c);
        break;
      case 'NotesCutoff':
        this.notesCutoff = c.tradingDate;
        break;
      case 'RecoveryHalt':
        this.auction = null;
        if (!OFF_HOURS.includes(this.phaseNow)) this.phaseNow = 'HALTED';
        break;
      case 'Tick':
        break;
    }
    this.flush();
    return this.outputs;
  }

  // ------------------------------------------------------------------- saídas

  private emit(eventType: string, board: Board, fields: Record<string, unknown>): void {
    const book = this.books[board];
    book.engineSeq++;
    this.outputs.push({
      eventType,
      board,
      engineSeq: book.engineSeq,
      inputSeq: this.input.inputSeq,
      ts: this.now,
      payload: {
        instrumentId: this.instrumentId,
        board,
        engineSeq: book.engineSeq,
        inputSeq: this.input.inputSeq,
        ...fields,
      },
    });
  }

  private touch(order: { board: Board; side: Side; price: IntPrice }): void {
    this.changed[order.board] = true;
    if (!isMarketLevel(order.price)) this.dirty[order.board][order.side].add(order.price);
  }

  /** Fecha a entrada: um delta por nível tocado e o indicativo de cada leilão que mudou. */
  private flush(): void {
    for (const board of BOARDS) {
      if (!this.changed[board]) continue;
      this.changed[board] = false;
      const book = this.books[board];
      for (const side of ['BUY', 'SELL'] as const) {
        const prices = this.dirty[board][side];
        if (prices.size === 0) continue;
        for (const price of prices) {
          const level = book.sideOf(side).level(price);
          this.emit('engine.book_changed', board, {
            side,
            price: formatPrice(price),
            newQuantity: level?.visible ?? 0,
            ordersCount: level?.count ?? 0,
          });
        }
        prices.clear();
      }
      if (this.auction) this.emitIndicative(board);
    }
  }

  /** RN-AUC-023: a cada mudança no livro. O *throttle* de 1/s é dos canais. */
  private emitIndicative(board: Board): void {
    const theoretical = theoreticalPrice(this.books[board], this.bands?.reference ?? null);
    this.emit('engine.auction_indicative', board, {
      auctionId: this.auction!.id,
      theoreticalPrice: theoretical ? formatPrice(theoretical.price) : null,
      theoreticalQuantity: theoretical?.quantity ?? 0,
      imbalanceSide: theoretical?.imbalanceSide ?? null,
      imbalanceQuantity: theoretical?.imbalanceQuantity ?? 0,
    });
  }

  private reject(board: Board, orderId: string, reason: string): void {
    this.emit('engine.order_rejected', board, { orderId, reason });
  }

  private emitBooked(order: RestingOrder): void {
    this.emit('engine.order_booked', order.board, {
      orderId: order.orderId,
      price: isMarketLevel(order.price) ? null : formatPrice(order.price),
      remainingQuantity: order.remaining,
      prioritySeq: order.prioritySeq,
    });
  }

  private emitCanceled(order: RestingOrder, quantity: number, reason: string): void {
    this.emit('engine.order_canceled', order.board, {
      orderId: order.orderId,
      canceledQuantity: quantity,
      reason,
    });
  }

  // ------------------------------------------------------------------- ordens

  private newOrder(c: NewOrderCommand): void {
    const book = this.books[c.board];
    if (this.seen.has(c.orderId)) return this.reject(c.board, c.orderId, 'DUPLICATE_ORDER_ID');
    const inAuction = isAuctionPhase(this.phaseNow);
    if (
      (this.phaseNow !== 'CONTINUOUS' && !inAuction) ||
      // RN-AUC-012 e RN-SES-004.
      (inAuction && (c.timeInForce === 'IOC' || c.timeInForce === 'FOK')) ||
      (this.phaseNow === 'CLOSING_CALL' && c.type === 'MARKET')
    )
      return this.reject(c.board, c.orderId, 'BOOK_NOT_OPEN');
    const limit = c.type === 'LIMIT' ? parsePrice(c.limitPrice!) : null;
    if (limit !== null && !insideBand(limit, this.bands?.rejection ?? null))
      return this.reject(c.board, c.orderId, 'PRICE_OUTSIDE_REJECTION_BAND');

    this.seen.add(c.orderId);
    const order = this.buildOrder(c, limit);
    if (inAuction) return this.rest(order);
    if (order.timeInForce === 'FOK' && !this.canFillCompletely(book, order)) {
      this.emitCanceled(order, order.remaining, 'FOK_NOT_FILLED');
      return;
    }
    this.aggress(order);
  }

  private buildOrder(c: NewOrderCommand, limit: IntPrice | null): RestingOrder {
    return {
      orderId: c.orderId,
      accountId: c.accountId,
      participantType: c.participantType,
      board: c.board,
      side: c.side,
      type: c.type,
      price: limit ?? (c.side === 'BUY' ? MARKET_BUY : MARKET_SELL),
      protection: c.protectionPrice === undefined ? null : parsePrice(c.protectionPrice),
      timeInForce: c.timeInForce,
      stpPolicy: c.stpPolicy,
      quantity: c.quantity,
      filled: 0,
      remaining: c.quantity,
      visible: 0,
      display: c.displayQuantity ?? null,
      prioritySeq: 0,
      version: 1,
      enteredAt: this.now,
      level: null,
      prev: null,
      next: null,
    };
  }

  /** Entra no livro no fim da fila do preço. */
  private rest(order: RestingOrder): void {
    order.visible = Math.min(order.display ?? order.remaining, order.remaining);
    this.books[order.board].add(order);
    this.touch(order);
    this.emitBooked(order);
  }

  /** Casamento na negociação contínua (Motor §4.1). */
  private aggress(order: RestingOrder): void {
    const book = this.books[order.board];
    const opposite = book.opposite(order.side);
    const buying = order.side === 'BUY';
    while (order.remaining > 0) {
      const level = opposite.best();
      if (!level) break;
      const price = level.price;
      if (order.type === 'LIMIT' && (buying ? price > order.price : price < order.price)) break;
      const resting = level.head!;
      if (resting.accountId === order.accountId) {
        const policy = order.stpPolicy;
        if (policy !== 'CANCEL_AGGRESSOR') this.cancelResting(resting, 'SELF_TRADE_PREVENTION');
        if (policy === 'CANCEL_RESTING') continue;
        this.finishAggressor(order, 'SELF_TRADE_PREVENTION');
        return;
      }
      const reason = this.bandViolation(order.board, price);
      if (reason) {
        this.triggerVolatilityAuction(reason);
        this.enterTriggeredAuction(order);
        return;
      }
      if (
        order.type === 'MARKET' &&
        order.protection !== null &&
        (buying ? price > order.protection : price < order.protection)
      )
        break;
      const quantity = Math.min(order.remaining, resting.visible);
      this.trade(
        buying ? order : resting,
        buying ? resting : order,
        price,
        quantity,
        order.side,
        undefined,
      );
      this.fillAggressor(order, quantity);
      this.fillResting(resting, quantity);
    }
    if (order.remaining === 0) {
      book.orders.delete(order.orderId);
      return;
    }
    if (order.type === 'MARKET') this.finishAggressor(order, 'MARKET_NO_LIQUIDITY');
    else if (order.timeInForce === 'IOC') this.finishAggressor(order, 'IOC_REMAINDER');
    else this.rest(order);
  }

  private fillAggressor(order: RestingOrder, quantity: number): void {
    order.filled += quantity;
    order.remaining -= quantity;
  }

  /** Baixa uma ordem do livro. Se a parte aparente acabou e há mais, recarrega (RN-ICE-001). */
  private fillResting(order: RestingOrder, quantity: number): void {
    const book = this.books[order.board];
    const level = order.level!;
    const visible = Math.min(quantity, order.visible);
    order.filled += quantity;
    order.remaining -= quantity;
    order.visible -= visible;
    level.visible -= visible;
    level.remaining -= quantity;
    this.touch(order);
    if (order.remaining === 0) {
      book.remove(order);
    } else if (order.visible === 0) {
      book.detach(order);
      order.visible = Math.min(order.display ?? order.remaining, order.remaining);
      book.add(order);
      this.emitBooked(order);
    }
  }

  /** Cancela o restante de quem não está na fila. */
  private finishAggressor(order: RestingOrder, reason: string): void {
    this.books[order.board].orders.delete(order.orderId);
    this.emitCanceled(order, order.remaining, reason);
    order.remaining = 0;
  }

  private cancelResting(order: RestingOrder, reason: string): void {
    this.touch(order);
    this.books[order.board].remove(order);
    this.emitCanceled(order, order.remaining, reason);
  }

  private cancelCommand(orderId: string, reason: string): void {
    const order = this.books.MAIN.orders.get(orderId) ?? this.books.ODD_LOT.orders.get(orderId);
    if (!order) return this.reject('MAIN', orderId, 'UNKNOWN_ORDER');
    this.cancelResting(order, reason);
  }

  private replaceOrder(c: ReplaceOrderCommand): void {
    const order = this.books.MAIN.orders.get(c.orderId) ?? this.books.ODD_LOT.orders.get(c.orderId);
    if (!order) return this.reject('MAIN', c.orderId, 'UNKNOWN_ORDER');
    const invalid = () => this.reject(order.board, c.orderId, 'INVALID_REPLACE');
    if (order.version !== c.expectedVersion) return invalid();
    // Pregão §4.1: nessas fases, só cancelamento.
    if (this.phaseNow === 'HALTED' || this.phaseNow === 'POST_CLOSE') return invalid();
    if (c.newLimitPrice !== undefined && order.type === 'MARKET') return invalid();
    if (c.newLimitPrice === undefined && c.newQuantity === undefined) return invalid();

    const price = c.newLimitPrice === undefined ? order.price : parsePrice(c.newLimitPrice);
    const quantity = c.newQuantity ?? order.quantity;
    if (quantity <= order.filled) return invalid(); // RN-ALT-002
    if (this.phaseNow === 'CLOSING_CALL') {
      const worse = order.side === 'BUY' ? price < order.price : price > order.price;
      if (worse || quantity > order.quantity) return invalid(); // RN-SES-004
    }
    if (c.newLimitPrice !== undefined && !insideBand(price, this.bands?.rejection ?? null))
      return this.reject(order.board, c.orderId, 'PRICE_OUTSIDE_REJECTION_BAND');

    const kept = price === order.price && quantity <= order.quantity; // RN-ALT-003
    const book = this.books[order.board];
    const parked = order.level === null;
    const nextRemaining = quantity - order.filled;
    if (kept) {
      const nextVisible = Math.min(order.visible, nextRemaining);
      if (order.level) {
        order.level.visible -= order.visible - nextVisible;
        order.level.remaining -= order.remaining - nextRemaining;
        this.touch(order);
      }
      order.visible = nextVisible;
    } else if (!parked) {
      this.touch(order);
      book.detach(order);
    }
    order.price = price;
    order.quantity = quantity;
    order.remaining = nextRemaining;
    order.version++;
    if (parked && !kept) order.prioritySeq = book.nextPriority++;
    this.emit('engine.order_replaced', order.board, {
      orderId: order.orderId,
      quantity,
      limitPrice: isMarketLevel(order.price) ? null : formatPrice(order.price),
      priorityKept: kept,
      version: order.version,
    });
    if (kept || parked) return;
    if (this.phaseNow === 'CONTINUOUS') this.aggress(order);
    else this.rest(order);
  }

  // ------------------------------------------------------------------- negócios

  private trade(
    buy: RestingOrder,
    sell: RestingOrder,
    price: IntPrice,
    quantity: number,
    aggressorSide: Side | 'NONE',
    auctionId: string | undefined,
  ): void {
    const board = buy.board;
    const book = this.books[board];
    const tradeId = deterministicId(this.now, this.hash, board, book.engineSeq + 1, IdKind.TRADE);
    this.emit('engine.trade_executed', board, {
      tradeId,
      price: formatPrice(price),
      quantity,
      buyOrderId: buy.orderId,
      sellOrderId: sell.orderId,
      buyAccountId: buy.accountId,
      sellAccountId: sell.accountId,
      buyParticipantType: buy.participantType,
      sellParticipantType: sell.participantType,
      aggressorSide,
      executedAt: iso(this.now),
      tradingDate: this.input.tradingDate,
      ...(auctionId ? { auctionId } : {}),
    });
    this.trades.set(tradeId, { board, busted: false });
    this.setLastPrice(board, price);
  }

  private setLastPrice(board: Board, price: IntPrice): void {
    const book = this.books[board];
    if (book.lastPrice === price && this.dynamicBands[board]) return;
    book.lastPrice = price;
    this.dynamicBands[board] = this.bands ? bandAround(price, this.bands.dynamic) : null;
  }

  private tradeBust(c: TradeBustCommand): void {
    const trade = this.trades.get(c.tradeId);
    const fields = { tradeId: c.tradeId, approvalRequestId: c.approvalRequestId };
    const refuse = (reason: string) =>
      this.emit('engine.trade_bust_rejected', trade?.board ?? 'MAIN', { ...fields, reason });
    if (this.notesCutoff === this.input.tradingDate) return refuse('NOTES_ALREADY_GENERATED');
    if (!trade) return refuse('TRADE_NOT_FOUND');
    if (trade.busted) return refuse('ALREADY_BUSTED');
    trade.busted = true;
    this.emit('engine.trade_busted', trade.board, fields);
  }

  // ------------------------------------------------------------------- túneis

  /** Túnel que o próximo negócio violaria, ou `null` (RN-AUC-030). */
  private bandViolation(board: Board, price: IntPrice): string | null {
    if (!this.bands) return null;
    if (!insideBand(price, this.dynamicBands[board])) return 'DYNAMIC_BAND';
    if (!insideBand(price, this.bands.static)) return 'STATIC_BAND';
    return null;
  }

  private bandUpdate(c: BandUpdateCommand): void {
    const reference = parsePrice(c.bandReferencePrice);
    this.bands = {
      reference,
      rejectionRate: c.rejectionBandPct,
      staticRate: c.staticAuctionBandPct,
      dynamicRate: c.dynamicAuctionBandPct,
      rejection: bandAround(reference, parseRate(c.rejectionBandPct)),
      static: bandAround(reference, parseRate(c.staticAuctionBandPct)),
      dynamic: parseRate(c.dynamicAuctionBandPct),
      volatilityDurationMs: c.volatilityAuctionDurationS * 1000,
      randomEndMaxMs: c.auctionRandomEndMaxS * 1000,
    };
    for (const board of BOARDS) {
      const last = this.books[board].lastPrice;
      this.dynamicBands[board] = last === null ? null : bandAround(last, this.bands.dynamic);
    }
  }

  private moveReference(price: IntPrice): void {
    const b = this.bands;
    if (!b) return;
    b.reference = price;
    b.rejection = bandAround(price, parseRate(b.rejectionRate));
    b.static = bandAround(price, parseRate(b.staticRate));
  }

  // ------------------------------------------------------------------- leilões

  /**
   * RN-AUC-030..032. A sessão só acompanha leilões do `MAIN`, e o leilão é do instrumento: a saída
   * sai sempre no `MAIN`, mesmo quando foi uma agressão no fracionário que parou no túnel.
   */
  private triggerVolatilityAuction(reason: string): void {
    const main = this.books.MAIN;
    const id = deterministicId(this.now, this.hash, 'MAIN', main.engineSeq + 1, IdKind.AUCTION);
    const expectedEnd = this.now + this.bands!.volatilityDurationMs;
    this.auction = {
      id,
      type: 'VOLATILITY',
      expectedEnd,
      seed: this.input.seed,
      concludeAt: null,
      target: 'CONTINUOUS',
      bounds: null,
    };
    this.phaseNow = 'VOLATILITY_AUCTION';
    this.markBooksChanged();
    this.emit('engine.auction_triggered', 'MAIN', {
      auctionId: id,
      type: 'VOLATILITY',
      reason,
      expectedEndAt: iso(expectedEnd),
    });
  }

  /** O leilão começa com o que já está no livro: a sessão decide o fim pelo indicativo (RN-AUC-003). */
  private markBooksChanged(): void {
    this.changed.MAIN = true;
    this.changed.ODD_LOT = true;
  }

  /** RN-AUC-031: o restante vai ao leilão; `MARKET` participa como mercado. `IOC` não entra. */
  private enterTriggeredAuction(order: RestingOrder): void {
    if (order.timeInForce === 'IOC') this.finishAggressor(order, 'IOC_REMAINDER');
    else this.rest(order);
  }

  private phaseChange(c: PhaseChangeCommand): void {
    const live = this.auction;
    if (c.concludesAuctionId && live?.id === c.concludesAuctionId) {
      live.target = c.phase;
      live.bounds = c.priceLimit
        ? { min: parsePrice(c.priceLimit.min), max: parsePrice(c.priceLimit.max) }
        : null;
      live.concludeAt =
        live.expectedEnd + randomEndOffset(live.seed, this.bands?.randomEndMaxMs ?? 0);
      this.settleDueAuction();
      return;
    }
    if (isAuctionPhase(c.phase)) {
      if (c.auctionId && live?.id === c.auctionId) {
        // Prorrogação (RN-AUC-003): a fase não muda, só o fim previsto.
        if (c.auctionEndAt) live.expectedEnd = Instant.parse(c.auctionEndAt).epochMillis;
        live.concludeAt = null;
        return;
      }
      this.auction = this.openAuction(c);
      this.markBooksChanged();
    } else {
      this.auction = null;
    }
    this.enterPhase(c.phase);
  }

  private openAuction(c: PhaseChangeCommand): Auction {
    const main = this.books.MAIN;
    return {
      id:
        c.auctionId ??
        deterministicId(this.now, this.hash, 'MAIN', main.engineSeq + 1, IdKind.AUCTION),
      type:
        c.auctionType ??
        (c.phase === 'CLOSING_CALL'
          ? 'CLOSING'
          : c.phase === 'VOLATILITY_AUCTION'
            ? 'VOLATILITY'
            : 'OPENING'),
      expectedEnd: c.auctionEndAt ? Instant.parse(c.auctionEndAt).epochMillis : this.now,
      seed: c.randomSeed === undefined ? this.input.seed : Number(c.randomSeed) >>> 0,
      concludeAt: null,
      target: 'CONTINUOUS',
      bounds: null,
    };
  }

  private settleDueAuction(): void {
    const a = this.auction;
    if (!a || a.concludeAt === null || a.concludeAt > this.input.ts) return;
    const inputTime = this.now;
    this.now = a.concludeAt;
    this.conclude(a);
    this.now = inputTime;
  }

  /** RN-AUC-020..022. */
  private conclude(a: Auction): void {
    this.auction = null;
    for (const board of BOARDS) {
      const book = this.books[board];
      const theoretical = theoreticalPrice(book, this.bands?.reference ?? null, a.bounds);
      let executed = 0;
      if (theoretical) executed = this.uncross(book, theoretical.price, a.id);
      this.cancelMarketRemainder(book);
      if (board === 'MAIN' && theoretical && executed > 0) this.moveReference(theoretical.price);
      this.emit('engine.auction_completed', board, {
        auctionId: a.id,
        price: theoretical && executed > 0 ? formatPrice(theoretical.price) : null,
        quantity: executed,
      });
    }
    this.enterPhase(a.target);
  }

  /** Ordens do lado que aceitam negociar em `price`, em prioridade preço-tempo. */
  private eligible(book: Book, side: Side, price: IntPrice): RestingOrder[] {
    const result: RestingOrder[] = [];
    const levels = book.sideOf(side).levels;
    for (let i = levels.length - 1; i >= 0; i--) {
      const level = levels[i]!;
      if (side === 'BUY' ? level.price < price : level.price > price) break;
      for (let o = level.head; o; o = o.next) {
        const limited =
          o.protection !== null && (side === 'BUY' ? o.protection < price : o.protection > price);
        if (!(isMarketLevel(level.price) && limited)) result.push(o);
      }
    }
    return result;
  }

  /** Executa no preço teórico, por prioridade, com STP (RN-AUC-021/022, RN-SLF-001). */
  private uncross(book: Book, price: IntPrice, auctionId: string): number {
    const buys = this.eligible(book, 'BUY', price);
    const sells = this.eligible(book, 'SELL', price);
    let executed = 0;
    let i = 0;
    let j = 0;
    while (i < buys.length && j < sells.length) {
      const buy = buys[i]!;
      const sell = sells[j]!;
      if (buy.accountId === sell.accountId) {
        // Sem agressora no leilão: vale como agressora a que chegou depois.
        const buyLater = buy.prioritySeq > sell.prioritySeq;
        const later = buyLater ? buy : sell;
        const earlier = buyLater ? sell : buy;
        const policy: StpPolicy = later.stpPolicy;
        const out = new Set<RestingOrder>();
        if (policy !== 'CANCEL_RESTING') out.add(later);
        if (policy !== 'CANCEL_AGGRESSOR') out.add(earlier);
        for (const order of out) this.cancelResting(order, 'SELF_TRADE_PREVENTION');
        if (out.has(buy)) i++;
        if (out.has(sell)) j++;
        continue;
      }
      const quantity = Math.min(buy.remaining, sell.remaining);
      this.trade(buy, sell, price, quantity, 'NONE', auctionId);
      this.fillResting(buy, quantity);
      this.fillResting(sell, quantity);
      executed += quantity;
      if (buy.remaining === 0) i++;
      if (sell.remaining === 0) j++;
    }
    return executed;
  }

  /** RN-AUC-011. */
  private cancelMarketRemainder(book: Book): void {
    for (const side of [book.bids, book.asks]) {
      const level = side.best();
      if (!level || !isMarketLevel(level.price)) continue;
      for (let o = level.head; o;) {
        const next = o.next;
        this.cancelResting(o, 'MARKET_NO_LIQUIDITY');
        o = next;
      }
    }
  }

  // ------------------------------------------------------------------- fases e fim do dia

  private enterPhase(phase: Phase): void {
    this.phaseNow = phase;
    if (phase === 'CLOSED') this.endOfDay();
    else if (phase === 'CONTINUOUS' || isAuctionPhase(phase)) this.representParked();
  }

  /**
   * RN-REC-005. As `DAY` saem do livro. As `GTC`/`GTD` também, mas ficam no índice sem nível, com o
   * `priority_seq` de sempre, até a reapresentação. Quem cuida do vencimento da `GTD` é o OMS.
   */
  private endOfDay(): void {
    for (const board of BOARDS) {
      const book = this.books[board];
      // Por `priority_seq`: a ordem do `Map` muda depois de restaurar um snapshot (RN-ME-002).
      const live = [...book.orders.values()].sort((a, b) => a.prioritySeq - b.prioritySeq);
      for (const order of live) {
        if (order.level === null) continue;
        if (order.timeInForce === 'GTC' || order.timeInForce === 'GTD') {
          this.touch(order);
          book.detach(order);
        } else {
          this.cancelResting(order, 'END_OF_DAY');
        }
      }
      book.lastPrice = null;
      this.dynamicBands[board] = null;
    }
    this.trades.clear();
    this.notesCutoff = null;
    // Em ordem fixa, como `parked` no snapshot: o estado restaurado precisa ser igual ao original.
    this.seen = new Set(
      [...this.books.MAIN.orders.keys(), ...this.books.ODD_LOT.orders.keys()].sort(),
    );
  }

  private representParked(): void {
    for (const board of BOARDS) {
      const book = this.books[board];
      const parked = [...book.orders.values()]
        .filter((o) => o.level === null)
        .sort((a, b) => a.prioritySeq - b.prioritySeq);
      for (const order of parked) {
        order.visible = Math.min(order.display ?? order.remaining, order.remaining);
        book.add(order, true);
        this.touch(order);
        this.emitBooked(order);
      }
    }
  }

  // ------------------------------------------------------------------- simulação do FOK

  /** RN-ME-030: percorre a agressão sem mexer em nada: limite, proteção, túneis e STP. */
  private canFillCompletely(book: Book, order: RestingOrder): boolean {
    const buying = order.side === 'BUY';
    const levels = book.opposite(order.side).levels;
    let missing = order.remaining;
    let dynamic = this.dynamicBands[order.board];
    let last = book.lastPrice;
    for (let i = levels.length - 1; i >= 0 && missing > 0; i--) {
      const level = levels[i]!;
      const price = level.price;
      if (order.type === 'LIMIT' && (buying ? price > order.price : price < order.price))
        return false;
      if (
        order.type === 'MARKET' &&
        order.protection !== null &&
        (buying ? price > order.protection : price < order.protection)
      )
        return false;
      // A fila simulada: um iceberg volta para o fim dela, e um STP pode estar logo atrás.
      const queue: { accountId: string; visible: number; hidden: number; display: number }[] = [];
      for (let o = level.head; o; o = o.next)
        queue.push({
          accountId: o.accountId,
          visible: o.visible,
          hidden: o.remaining - o.visible,
          display: o.display ?? o.remaining,
        });
      for (let head = 0; head < queue.length && missing > 0; head++) {
        const r = queue[head]!;
        if (r.accountId === order.accountId) {
          if (order.stpPolicy !== 'CANCEL_RESTING') return false;
          continue;
        }
        if (this.bands) {
          if (!insideBand(price, dynamic) || !insideBand(price, this.bands.static)) return false;
          if (price !== last) {
            last = price;
            dynamic = bandAround(price, this.bands.dynamic);
          }
        }
        const quantity = Math.min(missing, r.visible);
        missing -= quantity;
        r.visible -= quantity;
        if (r.visible === 0 && r.hidden > 0) {
          const reload = Math.min(r.display, r.hidden);
          queue.push({ ...r, visible: reload, hidden: r.hidden - reload });
        }
      }
    }
    return missing === 0;
  }

  // ------------------------------------------------------------------- leitura e snapshot

  /** O livro como o cenário o vê: do melhor para o pior preço, em ordem de fila. */
  bookView(board: Board): Record<'bids' | 'asks', BookLevelView[]> {
    const book = this.books[board];
    const view = (levels: Book['bids']['levels']): BookLevelView[] =>
      [...levels].reverse().map((level) => {
        const orders: BookOrderView[] = [];
        for (let o = level.head; o; o = o.next)
          orders.push({
            id: o.orderId,
            qty: o.remaining,
            ...(o.display !== null ? { aparente: o.visible } : {}),
          });
        return { price: isMarketLevel(level.price) ? 'MARKET' : formatPrice(level.price), orders };
      });
    return { bids: view(book.bids.levels), asks: view(book.asks.levels) };
  }

  snapshot(): EngineSnapshot {
    const dumpBook = (board: Board): BookSnapshot => {
      const book = this.books[board];
      const queued = (side: Side): OrderSnapshot[] => {
        const list: OrderSnapshot[] = [];
        for (const level of book.sideOf(side).levels)
          for (let o = level.head; o; o = o.next) list.push(dumpOrder(o));
        return list;
      };
      return {
        engineSeq: book.engineSeq,
        nextPriority: book.nextPriority,
        lastPrice: book.lastPrice,
        bids: queued('BUY'),
        asks: queued('SELL'),
        parked: [...book.orders.values()]
          .filter((o) => o.level === null)
          .sort((a, b) => a.prioritySeq - b.prioritySeq)
          .map(dumpOrder),
      };
    };
    return {
      instrumentId: this.instrumentId,
      inputSeq: this.lastInputSeq,
      phase: this.phaseNow,
      bands: this.bands
        ? {
            reference: this.bands.reference,
            rejectionRate: this.bands.rejectionRate,
            staticRate: this.bands.staticRate,
            dynamicRate: this.bands.dynamicRate,
            volatilityDurationMs: this.bands.volatilityDurationMs,
            randomEndMaxMs: this.bands.randomEndMaxMs,
          }
        : null,
      auction: this.auction ? { ...this.auction } : null,
      seen: [...this.seen],
      trades: [...this.trades].map(([id, t]) => ({ id, ...t })),
      notesCutoff: this.notesCutoff,
      main: dumpBook('MAIN'),
      oddLot: dumpBook('ODD_LOT'),
    };
  }

  static restore(s: EngineSnapshot): InstrumentEngine {
    const engine = new InstrumentEngine(s.instrumentId);
    engine.lastInputSeq = s.inputSeq;
    engine.phaseNow = s.phase;
    if (s.bands) {
      engine.bands = {
        ...s.bands,
        rejection: bandAround(s.bands.reference, parseRate(s.bands.rejectionRate)),
        static: bandAround(s.bands.reference, parseRate(s.bands.staticRate)),
        dynamic: parseRate(s.bands.dynamicRate),
      };
    }
    engine.auction = s.auction ? { ...s.auction } : null;
    engine.seen = new Set(s.seen);
    engine.trades = new Map(s.trades.map(({ id, ...t }) => [id, t]));
    engine.notesCutoff = s.notesCutoff;
    const loadBook = (board: Board, dump: BookSnapshot) => {
      const book = engine.books[board];
      book.engineSeq = dump.engineSeq;
      book.nextPriority = dump.nextPriority;
      book.lastPrice = dump.lastPrice;
      for (const o of [...dump.bids, ...dump.asks]) book.add(loadOrder(o), true);
      for (const o of dump.parked) book.orders.set(o.orderId, loadOrder(o));
      engine.dynamicBands[board] =
        dump.lastPrice !== null && engine.bands
          ? bandAround(dump.lastPrice, engine.bands.dynamic)
          : null;
    };
    loadBook('MAIN', s.main);
    loadBook('ODD_LOT', s.oddLot);
    return engine;
  }
}

export interface BookOrderView {
  id: string;
  qty: number;
  aparente?: number;
}

export interface BookLevelView {
  price: string;
  orders: BookOrderView[];
}

export interface OrderSnapshot {
  orderId: string;
  accountId: string;
  participantType: Participant;
  board: Board;
  side: Side;
  type: OrderType;
  price: IntPrice;
  protection: IntPrice | null;
  timeInForce: TimeInForce;
  stpPolicy: StpPolicy;
  quantity: number;
  filled: number;
  remaining: number;
  visible: number;
  display: number | null;
  prioritySeq: number;
  version: number;
  enteredAt: number;
}

interface BookSnapshot {
  engineSeq: number;
  nextPriority: number;
  lastPrice: IntPrice | null;
  bids: OrderSnapshot[];
  asks: OrderSnapshot[];
  parked: OrderSnapshot[];
}

/** Estado completo em JSON puro: `restore(snapshot())` se comporta como o original (RN-REC-001). */
export interface EngineSnapshot {
  instrumentId: string;
  inputSeq: number;
  phase: Phase;
  bands: {
    reference: IntPrice;
    rejectionRate: string;
    staticRate: string;
    dynamicRate: string;
    volatilityDurationMs: number;
    randomEndMaxMs: number;
  } | null;
  auction: Auction | null;
  seen: string[];
  trades: { id: string; board: Board; busted: boolean }[];
  notesCutoff: string | null;
  main: BookSnapshot;
  oddLot: BookSnapshot;
}

function dumpOrder(o: RestingOrder): OrderSnapshot {
  return {
    orderId: o.orderId,
    accountId: o.accountId,
    participantType: o.participantType,
    board: o.board,
    side: o.side,
    type: o.type,
    price: o.price,
    protection: o.protection,
    timeInForce: o.timeInForce,
    stpPolicy: o.stpPolicy,
    quantity: o.quantity,
    filled: o.filled,
    remaining: o.remaining,
    visible: o.visible,
    display: o.display,
    prioritySeq: o.prioritySeq,
    version: o.version,
    enteredAt: o.enteredAt,
  };
}

const loadOrder = (o: OrderSnapshot): RestingOrder => ({
  ...o,
  level: null,
  prev: null,
  next: null,
});
