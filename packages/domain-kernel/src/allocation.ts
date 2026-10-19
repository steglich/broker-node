import { Decimal, toDecimal, type DecimalInput } from './decimal.js';
import { DomainError } from './errors.js';
import { Money } from './money.js';

export interface AllocationItem {
  /** ID do item (ex.: `trade_id`, UUID v7). Usado no desempate. */
  readonly id: string;
  /** Peso do rateio (ex.: notional do negócio). Precisa ser ≥ 0. */
  readonly weight: DecimalInput;
}

/**
 * Rateio pelo maior resto (ADR-0004, RN-FEE-031).
 *
 * 1. Cada item recebe a parte proporcional ao peso, truncada na menor unidade (centavo).
 * 2. Os centavos que sobram (no máximo n − 1) vão, um por item, na ordem:
 *    maior resto → maior peso (valor) → menor `id` (UUID v7 lexicográfico = mais antigo).
 *
 * Garante Σ partes = total exatamente e resultado determinístico (não depende da ordem de entrada).
 * Premissa registrada (D5): o desempate é pelo menor `id`; o domínio só exige que seja determinístico.
 */
export function allocate(total: Money, items: readonly AllocationItem[]): Map<string, Money> {
  if (items.length === 0) throw new DomainError('INVALID_ALLOCATION', 'rateio sem itens');
  const ids = new Set(items.map((i) => i.id));
  if (ids.size !== items.length)
    throw new DomainError('INVALID_ALLOCATION', 'rateio com IDs repetidos');

  const weights = items.map((i) => {
    const w = toDecimal(i.weight, 'peso');
    if (w.isNegative() && !w.isZero())
      throw new DomainError('INVALID_ALLOCATION', `peso negativo no item ${i.id}`);
    return w;
  });
  const weightSum = weights.reduce((a, b) => a.plus(b), new Decimal(0));
  if (weightSum.isZero()) throw new DomainError('INVALID_ALLOCATION', 'a soma dos pesos é zero');

  // Trabalha em menor unidade e com o valor absoluto; o sinal volta no fim.
  const totalMinor = total.toMinor();
  const sign = totalMinor < 0n ? -1n : 1n;
  const absMinor = new Decimal((totalMinor * sign).toString());

  const shares = items.map((item, idx) => {
    const exact = absMinor.times(weights[idx]!).dividedBy(weightSum);
    const floor = exact.floor();
    return {
      id: item.id,
      weight: weights[idx]!,
      minor: BigInt(floor.toFixed(0)),
      remainder: exact.minus(floor),
    };
  });

  const distributed = shares.reduce((acc, s) => acc + s.minor, 0n);
  let residual = totalMinor * sign - distributed;

  const order = [...shares].sort(
    (a, b) =>
      b.remainder.comparedTo(a.remainder) ||
      b.weight.comparedTo(a.weight) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const share of order) {
    if (residual === 0n) break;
    share.minor += 1n;
    residual -= 1n;
  }

  return new Map(shares.map((s) => [s.id, Money.fromMinor(s.minor * sign, total.currency)]));
}
