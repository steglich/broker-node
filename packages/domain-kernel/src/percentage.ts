import { type Decimal, toDecimal, type DecimalInput } from './decimal.js';
import { DomainError } from './errors.js';
import type { Money } from './money.js';

/** Escala de taxas e alíquotas (ADR-0004): 8 casas. */
export const RATE_SCALE = 8;

/**
 * Taxa ou alíquota. Guarda a fração (5% = 0.05) com até 8 casas, por exemplo os emolumentos
 * de 0,005% = 0.00005000.
 */
export class Percentage {
  private constructor(readonly fraction: Decimal) {}

  /** A partir da fração: `fromFraction("0.00005")` = 0,005%. */
  static fromFraction(value: DecimalInput): Percentage {
    const d = toDecimal(value, 'Percentage');
    if (d.decimalPlaces() > RATE_SCALE) {
      throw new DomainError(
        'INVALID_SCALE',
        `taxa com mais de ${RATE_SCALE} casas: ${d.toString()}`,
      );
    }
    return new Percentage(d);
  }

  /** A partir do percentual: `fromPercent("0.005")` = 0,005% = fração 0.00005. */
  static fromPercent(value: DecimalInput): Percentage {
    return Percentage.fromFraction(toDecimal(value, 'Percentage').dividedBy(100));
  }

  /** Aplica a taxa sem arredondar (cálculo intermediário; arredonde no fim). */
  applyTo(money: Money): Money {
    return money.times(this.fraction);
  }

  asPercent(): Decimal {
    return this.fraction.times(100);
  }

  equals(other: Percentage): boolean {
    return this.fraction.equals(other.fraction);
  }

  /** Fração com 8 casas (`"0.00005000"`). */
  toString(): string {
    return this.fraction.toFixed(RATE_SCALE);
  }

  toJSON(): string {
    return this.toString();
  }
}
