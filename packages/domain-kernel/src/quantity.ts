import { DomainError } from './errors.js';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INTEGER_PATTERN = /^-?\d+$/;

/**
 * Quantidade de ativos: inteiro de 64 bits (bigint). Pode ser negativa em posições
 * (venda a descoberto); quantidade de ordem usa `Quantity.positive`.
 */
export class Quantity {
  private constructor(readonly value: bigint) {}

  /** A partir de bigint ou string inteira. `10.5` e `number` são recusados. */
  static of(value: bigint | string): Quantity {
    let v: bigint;
    if (typeof value === 'bigint') v = value;
    else if (typeof value === 'string' && INTEGER_PATTERN.test(value)) v = BigInt(value);
    else
      throw new DomainError('INVALID_QUANTITY', `quantidade precisa ser inteira: ${String(value)}`);
    if (v < INT64_MIN || v > INT64_MAX) {
      throw new DomainError('INVALID_QUANTITY', `quantidade fora de 64 bits: ${v}`);
    }
    return new Quantity(v);
  }

  /** Quantidade de ordem: inteira e maior que zero. */
  static positive(value: bigint | string): Quantity {
    const q = Quantity.of(value);
    if (q.value <= 0n)
      throw new DomainError(
        'INVALID_QUANTITY',
        `quantidade precisa ser maior que zero: ${q.value}`,
      );
    return q;
  }

  static zero(): Quantity {
    return new Quantity(0n);
  }

  plus(other: Quantity): Quantity {
    return Quantity.of(this.value + other.value);
  }

  minus(other: Quantity): Quantity {
    return Quantity.of(this.value - other.value);
  }

  equals(other: Quantity): boolean {
    return this.value === other.value;
  }

  compare(other: Quantity): -1 | 0 | 1 {
    return this.value < other.value ? -1 : this.value > other.value ? 1 : 0;
  }

  toString(): string {
    return this.value.toString();
  }

  /** Quantidade vai como string no JSON (bigint não serializa e pode passar de 2^53). */
  toJSON(): string {
    return this.toString();
  }
}
