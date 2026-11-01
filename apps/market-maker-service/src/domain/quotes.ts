import { Decimal } from '@broker/domain-kernel';
import type { SmmParams } from './params.js';
import type { Side } from './position.js';

export type Board = 'MAIN' | 'ODD_LOT';

export interface QuoteLevel {
  board: Board;
  side: Side;
  price: Decimal;
  quantity: number;
}

export interface QuoteInput {
  reference: Decimal;
  tick: Decimal;
  lotSize: number;
  /** Ações, relativo ao estoque inicial. */
  inventory: number;
  params: SmmParams;
  /** Só o nível 1 em `ref ± meio_spread`, sem inclinação (Motor §6.6). */
  single: boolean;
  /** RN-SMM-032: alargamento do spread por defasagem. */
  spreadMultiplier: number;
  /** Faixa do túnel de rejeição; `null` enquanto o `BandUpdate` não chegou. */
  band: { low: Decimal; high: Decimal } | null;
  /** O livro fracionário existe para este instrumento (RN-INS-006). */
  oddLot: boolean;
}

const BPS = new Decimal(10_000);

/** RN-SMM-001: `inv_max`, em ações. */
export const inventoryLimit = (params: SmmParams, lotSize: number) =>
  params.inventoryLimitLots * lotSize;

export function halfSpread(
  reference: Decimal,
  tick: Decimal,
  spreadBps: number,
  multiplier = 1,
): Decimal {
  return Decimal.max(tick, reference.times(spreadBps).times(multiplier).div(2).div(BPS));
}

/** `arredonda_lote`: para baixo, no mínimo um lote. O domínio não diz o sentido; para baixo nunca passa do pedido. */
export function levelQuantity(params: SmmParams, lotSize: number, level: number): number {
  const lots = new Decimal(params.baseQuantityLots)
    .times(new Decimal(params.levelMultiplier).pow(level))
    .floor();
  return Decimal.max(lots, 1).toNumber() * lotSize;
}

const downToTick = (price: Decimal, tick: Decimal) => price.div(tick).floor().times(tick);
const upToTick = (price: Decimal, tick: Decimal) => price.div(tick).ceil().times(tick);

/**
 * Cotações do Motor §6.3 com as garantias de RN-SMM-001/002. Um nível fora do túnel ou sem preço
 * positivo é omitido, em vez de empilhado na borda. Cada lado para na capacidade do inventário: a
 * soma das ofertas nunca leva `inv` além de `±inv_max`, o que mantém o estoque finito (RN-SMM-021).
 */
export function computeQuotes(q: QuoteInput): QuoteLevel[] {
  const { params, tick, lotSize, inventory } = q;
  const half = halfSpread(q.reference, tick, params.spreadBps, q.spreadMultiplier);
  const step = Decimal.max(tick, q.reference.times(params.levelStepBps).div(BPS));
  const limit = inventoryLimit(params, lotSize);
  const skew = q.single
    ? new Decimal(0)
    : new Decimal(params.skewFactor).times(inventory).div(limit).times(half).negated();
  const center = q.reference.plus(skew);
  const inBand = (price: Decimal) =>
    price.greaterThan(0) &&
    (!q.band || (price.greaterThanOrEqualTo(q.band.low) && price.lessThanOrEqualTo(q.band.high)));

  const levels: QuoteLevel[] = [];
  const side = (
    s: Side,
    capacityStart: number,
    priceAt: (offset: Decimal) => Decimal,
    best: Decimal,
  ) => {
    let capacity = Math.max(capacityStart, 0);
    for (let i = 0; i < (q.single ? 1 : params.levels); i++) {
      const price = priceAt(half.plus(step.times(i)));
      const wanted = levelQuantity(params, lotSize, i);
      const quantity = Math.min(wanted, Math.floor(capacity / lotSize) * lotSize);
      if (quantity === 0) break;
      if (!inBand(price)) continue;
      levels.push({ board: 'MAIN', side: s, price, quantity });
      capacity -= quantity;
    }
    if (q.single || !q.oddLot || !params.oddLotEnabled || lotSize === 1) return;
    const oddQuantity = Math.min(lotSize - 1, capacity);
    if (oddQuantity > 0 && inBand(best))
      levels.push({ board: 'ODD_LOT', side: s, price: best, quantity: oddQuantity });
  };
  side(
    'BUY',
    limit - inventory,
    (offset) => downToTick(center.minus(offset), tick),
    downToTick(center.minus(half), tick),
  );
  side(
    'SELL',
    limit + inventory,
    (offset) => upToTick(center.plus(offset), tick),
    upToTick(center.plus(half), tick),
  );
  return levels;
}

/** Oferta de cliente em repouso: o livro do Motor sem as ofertas do próprio FMS. */
export interface ClientLevel {
  side: Side;
  price: Decimal;
  quantity: number;
}

export interface SweepOrder {
  side: Side;
  price: Decimal;
  quantity: number;
}

export interface SweepPlan {
  sweep: SweepOrder | null;
  /** As cotações sem as que cruzariam o que sobrar de cliente depois da varredura. */
  quotes: QuoteLevel[];
}

/**
 * RN-SMM-012: a varredura é uma ordem `IOC` no melhor preço da nova cotação, limitada a
 * `smm_max_sweep_lots` e à capacidade do inventário. O que sobra de cliente além do limite fica para
 * a próxima recotação, e por isso nenhuma cotação em repouso pode cruzar essa sobra.
 */
export function planSweep(
  quotes: readonly QuoteLevel[],
  clients: readonly ClientLevel[],
  input: { inventory: number; lotSize: number; params: SmmParams },
): SweepPlan {
  const main = quotes.filter((q) => q.board === 'MAIN');
  const limit = inventoryLimit(input.params, input.lotSize);
  for (const side of ['BUY', 'SELL'] as const) {
    const own = main.filter((q) => q.side === side);
    const best = own.length ? own[0]!.price : null;
    if (!best) continue;
    const buying = side === 'BUY';
    const crossing = clients
      .filter(
        (c) =>
          c.side !== side &&
          c.quantity > 0 &&
          (buying ? c.price.lessThanOrEqualTo(best) : c.price.greaterThanOrEqualTo(best)),
      )
      .sort((a, b) => (buying ? a.price.comparedTo(b.price) : b.price.comparedTo(a.price)));
    if (crossing.length === 0) continue;
    const available = crossing.reduce((sum, c) => sum + c.quantity, 0);
    const capacity = buying ? limit - input.inventory : limit + input.inventory;
    const lots = Math.floor(
      Math.min(available, input.params.maxSweepLots * input.lotSize, Math.max(capacity, 0)) /
        input.lotSize,
    );
    const quantity = lots * input.lotSize;
    let left = quantity;
    const remaining = crossing.find((c) => {
      if (left >= c.quantity) {
        left -= c.quantity;
        return false;
      }
      return true;
    });
    const crosses = (q: QuoteLevel) =>
      remaining !== undefined &&
      q.board === 'MAIN' &&
      q.side === side &&
      (buying
        ? q.price.greaterThanOrEqualTo(remaining.price)
        : q.price.lessThanOrEqualTo(remaining.price));
    return {
      sweep: quantity > 0 ? { side, price: best, quantity } : null,
      quotes: reduceCapacity(
        quotes.filter((q) => !crosses(q)),
        side,
        quantity,
        capacity,
        input.lotSize,
      ),
    };
  }
  return { sweep: null, quotes: [...quotes] };
}

/** A varredura consome capacidade do inventário: as cotações do lado dela cabem no que restou. */
function reduceCapacity(
  quotes: readonly QuoteLevel[],
  side: Side,
  swept: number,
  capacity: number,
  lotSize: number,
): QuoteLevel[] {
  let left = Math.max(capacity - swept, 0);
  const out: QuoteLevel[] = [];
  for (const q of quotes) {
    if (q.side !== side) {
      out.push(q);
      continue;
    }
    const unit = q.board === 'MAIN' ? lotSize : 1;
    const quantity = Math.min(q.quantity, Math.floor(left / unit) * unit);
    if (quantity === 0) continue;
    out.push({ ...q, quantity });
    left -= quantity;
  }
  return out;
}

/** Oferta do FMS em aberto, como guardada em `smm_state.live_orders`. */
export interface LiveOrder {
  orderId: string;
  board: Board;
  side: Side;
  /** Texto normalizado (`Decimal.toFixed()`): é o que a comparação da recotação usa. */
  price: string;
  remaining: number;
  /** `SENT` até o Motor confirmar; `CANCELING` depois do comando de cancelamento. */
  status: 'SENT' | 'BOOKED' | 'CANCELING';
  /** Ordem `IOC` da varredura: termina sozinha e não é nível a repor. */
  sweep: boolean;
}

export interface RequoteDiff {
  cancel: LiveOrder[];
  place: QuoteLevel[];
}

/**
 * RN-SMM-011: o que muda sai por cancelamento + nova ordem, nunca por `ReplaceOrder`. O nível igual
 * ao desejado fica onde está: reenviá-lo só geraria comandos, sem mudar a cotação.
 */
export function diffQuotes(
  live: readonly LiveOrder[],
  desired: readonly QuoteLevel[],
): RequoteDiff {
  const key = (board: Board, side: Side, price: string, quantity: number) =>
    `${board}|${side}|${price}|${quantity}`;
  const wanted = new Map<string, QuoteLevel>();
  for (const q of desired) wanted.set(key(q.board, q.side, q.price.toFixed(), q.quantity), q);
  const cancel: LiveOrder[] = [];
  for (const o of live) {
    if (o.sweep || o.status === 'CANCELING') continue;
    const k = key(o.board, o.side, o.price, o.remaining);
    if (!wanted.delete(k)) cancel.push(o);
  }
  return { cancel, place: [...wanted.values()] };
}

/**
 * RN-SMM-032: `×2` por hora inteira desde que a referência foi declarada defasada, até `×8`; depois
 * disso (a partir da 4ª hora) o FMS para, e o retorno é `null`.
 */
export function stalenessMultiplier(staleForMs: number | null): number | null {
  if (staleForMs === null || staleForMs < 0) return 1;
  const hours = Math.floor(staleForMs / 3_600_000);
  return hours > 3 ? null : 2 ** hours;
}

/** Spread efetivo em bps, sobre o meio. `null` sem as duas pontas (RN-SMM-031). */
export function effectiveSpreadBps(bid: Decimal | null, ask: Decimal | null): Decimal | null {
  if (!bid || !ask) return null;
  return ask.minus(bid).div(ask.plus(bid).div(2)).times(BPS);
}
