import { type Book, type BookSide, isMarketLevel } from './book.js';
import type { IntPrice } from './price.js';

export type ImbalanceSide = 'BUY' | 'SELL' | null;

export interface Theoretical {
  price: IntPrice;
  quantity: number;
  imbalanceSide: ImbalanceSide;
  imbalanceQuantity: number;
}

export interface PriceBounds {
  min: IntPrice;
  max: IntPrice;
}

interface Candidate {
  price: IntPrice;
  demand: number;
  supply: number;
  executable: number;
  imbalance: number;
  side: ImbalanceSide;
}

/** Quantidade `MARKET` disposta a negociar em `price`: o preço de proteção ainda limita (RN-AUC-031). */
function marketQuantity(side: BookSide, price: IntPrice): number {
  const level = side.best();
  if (!level || !isMarketLevel(level.price)) return 0;
  let total = 0;
  for (let o = level.head; o; o = o.next) {
    const limited =
      o.protection !== null && (side.side === 'BUY' ? o.protection < price : o.protection > price);
    if (!limited) total += o.remaining;
  }
  return total;
}

function candidateAt(book: Book, price: IntPrice): Candidate {
  let demand = marketQuantity(book.bids, price);
  for (const level of book.bids.levels)
    if (!isMarketLevel(level.price) && level.price >= price) demand += level.remaining;
  let supply = marketQuantity(book.asks, price);
  for (const level of book.asks.levels)
    if (!isMarketLevel(level.price) && level.price <= price) supply += level.remaining;
  return {
    price,
    demand,
    supply,
    executable: Math.min(demand, supply),
    imbalance: Math.abs(demand - supply),
    side: demand > supply ? 'BUY' : supply > demand ? 'SELL' : null,
  };
}

/** Todos os preços limite presentes no livro, sem repetir, do menor para o maior (Motor §5.2). */
function candidatePrices(book: Book): IntPrice[] {
  const prices = new Set<IntPrice>();
  for (const side of [book.bids, book.asks])
    for (const level of side.levels) if (!isMarketLevel(level.price)) prices.add(level.price);
  return [...prices].sort((a, b) => a - b);
}

/**
 * Preço teórico (Motor §5.2): maior executável, menor desequilíbrio, lado do desequilíbrio,
 * proximidade da referência e, por fim, o mais alto. `null` sem nada executável (RN-AUC-020).
 *
 * `bounds` é a política de conclusão de RN-AUC-003: o preço escolhido é trazido para o túnel e a
 * quantidade é recalculada nele.
 */
export function theoreticalPrice(
  book: Book,
  reference: IntPrice | null,
  bounds: PriceBounds | null = null,
): Theoretical | null {
  let tied: Candidate[] = [];
  for (const price of candidatePrices(book)) {
    const c = candidateAt(book, price);
    if (c.executable === 0) continue;
    const head = tied[0];
    if (
      !head ||
      c.executable > head.executable ||
      (c.executable === head.executable && c.imbalance < head.imbalance)
    )
      tied = [c];
    else if (c.executable === head.executable && c.imbalance === head.imbalance) tied.push(c);
  }
  if (tied.length === 0) return null;

  // Os candidatos estão em ordem crescente de preço.
  let chosen = tied[tied.length - 1]!;
  if (tied.length > 1) {
    if (tied.every((c) => c.side === 'BUY')) chosen = tied[tied.length - 1]!;
    else if (tied.every((c) => c.side === 'SELL')) chosen = tied[0]!;
    else if (reference !== null) {
      // Em empate de distância fica o mais alto: a varredura é crescente e aceita `<=`.
      let nearest = Number.MAX_SAFE_INTEGER;
      for (const c of tied) {
        const distance = Math.abs(c.price - reference);
        if (distance <= nearest) {
          nearest = distance;
          chosen = c;
        }
      }
    }
  }
  if (bounds && (chosen.price < bounds.min || chosen.price > bounds.max)) {
    chosen = candidateAt(book, Math.min(bounds.max, Math.max(bounds.min, chosen.price)));
    if (chosen.executable === 0) return null;
  }
  return {
    price: chosen.price,
    quantity: chosen.executable,
    imbalanceSide: chosen.side,
    imbalanceQuantity: chosen.imbalance,
  };
}
