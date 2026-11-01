import { Decimal } from '@broker/domain-kernel';

export type Side = 'BUY' | 'SELL';

/** Inventário e resultado do FMS num instrumento (RN-SMM-031). `inventory` é relativo ao estoque inicial. */
export interface Position {
  inventory: number;
  /** Custo médio do inventário aberto, comprado ou vendido; zero sem inventário. */
  averageCost: Decimal;
  cashFlow: Decimal;
  realizedPnl: Decimal;
  volume: number;
}

export const EMPTY_POSITION: Position = {
  inventory: 0,
  averageCost: new Decimal(0),
  cashFlow: new Decimal(0),
  realizedPnl: new Decimal(0),
  volume: 0,
};

/** Custo médio: aumentar o inventário reprecifica; reduzir realiza a diferença; virar de lado abre ao preço do negócio. */
export function applyFill(p: Position, side: Side, quantity: number, price: Decimal): Position {
  const signed = side === 'BUY' ? quantity : -quantity;
  const inventory = p.inventory + signed;
  const cashFlow = p.cashFlow.minus(price.times(signed));
  const volume = p.volume + quantity;
  if (p.inventory === 0 || Math.sign(p.inventory) === Math.sign(signed)) {
    const averageCost = p.averageCost
      .times(Math.abs(p.inventory))
      .plus(price.times(quantity))
      .div(Math.abs(inventory));
    return { inventory, averageCost, cashFlow, realizedPnl: p.realizedPnl, volume };
  }
  const closed = Math.min(Math.abs(p.inventory), quantity);
  const perShare = p.inventory > 0 ? price.minus(p.averageCost) : p.averageCost.minus(price);
  const realizedPnl = p.realizedPnl.plus(perShare.times(closed));
  let averageCost = p.averageCost;
  if (inventory === 0) averageCost = new Decimal(0);
  else if (Math.sign(inventory) !== Math.sign(p.inventory)) averageCost = price;
  return { inventory, averageCost, cashFlow, realizedPnl, volume };
}

/** Inventário aberto a mercado pela referência. */
export function unrealizedPnl(p: Position, reference: Decimal): Decimal {
  return reference.minus(p.averageCost).times(p.inventory);
}
