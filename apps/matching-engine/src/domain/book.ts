import { MARKET_BUY, MARKET_SELL, type IntPrice } from './price.js';

export type Board = 'MAIN' | 'ODD_LOT';
export type Side = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET';
export type TimeInForce = 'DAY' | 'GTC' | 'GTD' | 'IOC' | 'FOK';
export type Participant = 'CUSTOMER' | 'MARKET_MAKER' | 'SYSTEM';
export type StpPolicy = 'CANCEL_AGGRESSOR' | 'CANCEL_RESTING' | 'CANCEL_BOTH';

/** Ordem no livro (Motor §3.1). É nó de uma lista duplamente ligada: sair da fila é O(1). */
export interface RestingOrder {
  orderId: string;
  accountId: string;
  participantType: Participant;
  board: Board;
  side: Side;
  type: OrderType;
  /** Preço de ordenação; em `MARKET` de leilão, o limite mais agressivo (RN-AUC-011). */
  price: IntPrice;
  protection: IntPrice | null;
  timeInForce: TimeInForce;
  stpPolicy: StpPolicy;
  /** Quantidade total da ordem (entra no `newQuantity` da alteração, RN-ALT-002). */
  quantity: number;
  filled: number;
  /** Tudo o que falta executar: `visible` + a parte oculta do iceberg. */
  remaining: number;
  visible: number;
  display: number | null;
  prioritySeq: number;
  version: number;
  enteredAt: number;
  level: PriceLevel | null;
  prev: RestingOrder | null;
  next: RestingOrder | null;
}

/** Nível de preço com fila FIFO (RN-ME-010). */
export class PriceLevel {
  head: RestingOrder | null = null;
  tail: RestingOrder | null = null;
  count = 0;
  /** Soma da parte aparente: é o que `engine.book_changed` publica. */
  visible = 0;
  /** Soma do que falta executar: é o que conta no preço teórico (Motor §5.2). */
  remaining = 0;

  constructor(readonly price: IntPrice) {}

  pushBack(order: RestingOrder): void {
    order.level = this;
    order.prev = this.tail;
    order.next = null;
    if (this.tail) this.tail.next = order;
    else this.head = order;
    this.tail = order;
    this.count++;
    this.visible += order.visible;
    this.remaining += order.remaining;
  }

  unlink(order: RestingOrder): void {
    if (order.prev) order.prev.next = order.next;
    else this.head = order.next;
    if (order.next) order.next.prev = order.prev;
    else this.tail = order.prev;
    order.prev = null;
    order.next = null;
    order.level = null;
    this.count--;
    this.visible -= order.visible;
    this.remaining -= order.remaining;
  }
}

/**
 * Um lado do livro. Os níveis ficam num array ordenado com o melhor preço no fim: consumir o topo é
 * `pop()` e inserir é busca binária + `splice`, o que num livro de dezenas de níveis ganha de uma
 * árvore em memória e não aloca nó por nível (D12, risco de GC).
 */
export class BookSide {
  /** Do pior para o melhor. */
  readonly levels: PriceLevel[] = [];

  constructor(readonly side: Side) {}

  /** `a` vem depois de `b` no array, isto é, `a` é melhor. */
  private better(a: IntPrice, b: IntPrice): boolean {
    return this.side === 'BUY' ? a > b : a < b;
  }

  best(): PriceLevel | null {
    return this.levels.length === 0 ? null : this.levels[this.levels.length - 1]!;
  }

  private search(price: IntPrice): number {
    let low = 0;
    let high = this.levels.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.better(price, this.levels[mid]!.price)) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  level(price: IntPrice): PriceLevel | null {
    const at = this.search(price);
    const found = this.levels[at];
    return found && found.price === price ? found : null;
  }

  levelFor(price: IntPrice): PriceLevel {
    const at = this.search(price);
    const found = this.levels[at];
    if (found && found.price === price) return found;
    const level = new PriceLevel(price);
    this.levels.splice(at, 0, level);
    return level;
  }

  removeIfEmpty(level: PriceLevel): void {
    if (level.count > 0) return;
    const at = this.search(level.price);
    if (this.levels[at] === level) this.levels.splice(at, 1);
  }
}

export const isMarketLevel = (price: IntPrice): boolean =>
  price === MARKET_BUY || price === MARKET_SELL;

/** Livro de um quadro: dois lados, índice por ordem e os contadores de sequência do livro. */
export class Book {
  readonly bids = new BookSide('BUY');
  readonly asks = new BookSide('SELL');
  readonly orders = new Map<string, RestingOrder>();
  nextPriority = 1;
  engineSeq = 0;
  lastPrice: IntPrice | null = null;

  constructor(readonly board: Board) {}

  sideOf(side: Side): BookSide {
    return side === 'BUY' ? this.bids : this.asks;
  }

  opposite(side: Side): BookSide {
    return side === 'BUY' ? this.asks : this.bids;
  }

  /** Coloca no fim da fila do preço; sem `keepPriority`, recebe um `priority_seq` novo. */
  add(order: RestingOrder, keepPriority = false): void {
    if (!keepPriority) order.prioritySeq = this.nextPriority++;
    this.sideOf(order.side).levelFor(order.price).pushBack(order);
    this.orders.set(order.orderId, order);
  }

  /** Tira da fila e do índice. */
  remove(order: RestingOrder): void {
    this.detach(order);
    this.orders.delete(order.orderId);
  }

  /** Tira da fila, mantendo no índice (a ordem vai voltar: recarga ou alteração). */
  detach(order: RestingOrder): void {
    const level = order.level;
    if (!level) return;
    level.unlink(order);
    this.sideOf(order.side).removeIfEmpty(level);
  }
}
