import { Decimal, toDecimal, type DecimalInput } from './decimal.js';
import { DomainError } from './errors.js';
import { roundDecimal, type RoundingMode } from './rounding.js';

/** Código de moeda ISO 4217 (3 letras maiúsculas). Só BRL é usado hoje, mas é sempre explícito. */
export type Currency = string;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/** Casas da menor unidade por moeda (centavos para BRL). */
const MINOR_UNITS: Record<string, number> = { BRL: 2, USD: 2, EUR: 2 };

function assertCurrency(currency: string): Currency {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new DomainError('INVALID_CURRENCY', `moeda inválida (ISO 4217): ${currency}`);
  }
  return currency;
}

/**
 * Valor monetário com moeda explícita (ADR-0004, P-01).
 * Pode carregar mais casas que a moeda em cálculos intermediários (≥ 8, ADR-0004); o
 * arredondamento para lançamento é sempre explícito com `round`.
 */
export class Money {
  private constructor(
    readonly amount: Decimal,
    readonly currency: Currency,
  ) {}

  /** A partir de string decimal (`"0.10"`), bigint ou Decimal. `number` é recusado. */
  static of(amount: DecimalInput, currency: Currency): Money {
    return new Money(toDecimal(amount, 'Money'), assertCurrency(currency));
  }

  /** A partir de inteiro na menor unidade (centavos): `fromMinor(10n, 'BRL')` = 0,10. */
  static fromMinor(minor: bigint, currency: Currency): Money {
    if (typeof minor !== 'bigint') {
      throw new DomainError('INVALID_DECIMAL', 'a menor unidade precisa ser bigint');
    }
    const c = assertCurrency(currency);
    return new Money(new Decimal(minor.toString()).dividedBy(10 ** Money.minorUnits(c)), c);
  }

  static zero(currency: Currency): Money {
    return new Money(new Decimal(0), assertCurrency(currency));
  }

  static minorUnits(currency: Currency): number {
    return MINOR_UNITS[currency] ?? 2;
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  /** Multiplica por um fator decimal (quantidade, taxa). Não arredonda. */
  times(factor: DecimalInput): Money {
    return new Money(this.amount.times(toDecimal(factor, 'fator')), this.currency);
  }

  negated(): Money {
    return new Money(this.amount.negated(), this.currency);
  }

  /** Arredonda explicitamente. Sem `scale`, usa as casas da moeda (2 para BRL). */
  round(mode: RoundingMode, scale = Money.minorUnits(this.currency)): Money {
    return new Money(roundDecimal(this.amount, scale, mode), this.currency);
  }

  /** Valor em centavos; exige que o valor já esteja na escala da moeda (arredonde antes). */
  toMinor(): bigint {
    const scaled = this.amount.times(10 ** Money.minorUnits(this.currency));
    if (!scaled.isInteger()) {
      throw new DomainError(
        'INVALID_SCALE',
        `valor com casas além da moeda: ${this.toString()}; arredonde antes`,
      );
    }
    return BigInt(scaled.toFixed(0));
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.amount.comparedTo(other.amount) as -1 | 0 | 1;
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isNegative(): boolean {
    return this.amount.isNegative() && !this.amount.isZero();
  }

  /** String decimal com ao menos as casas da moeda (`"3851.15"`), como na API (ADR-0004 §3). */
  toString(): string {
    const minor = Money.minorUnits(this.currency);
    return this.amount.toFixed(Math.max(minor, this.amount.decimalPlaces()));
  }

  toJSON(): { amount: string; currency: Currency } {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `moedas diferentes: ${this.currency} e ${other.currency}`,
      );
    }
  }
}
