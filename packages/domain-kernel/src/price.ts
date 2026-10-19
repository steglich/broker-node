import { Decimal, toDecimal, type DecimalInput } from './decimal.js';
import { DomainError } from './errors.js';
import { roundDecimal, type RoundingMode } from './rounding.js';

/** Escala máxima interna de preços de referência e PM (ADR-0004). */
export const PRICE_MAX_SCALE = 8;
/** Preço de negociação: 2 casas (tick 0,01); o tipo suporta 4 (ADR-0004). */
export const TRADING_PRICE_MAX_SCALE = 4;

/** Preço unitário (não carrega moeda: é sempre o preço do instrumento na moeda dele). */
export class Price {
  private constructor(readonly value: Decimal) {}

  /** Preço com até 8 casas (referência, PM). Recusa negativo e `number`. */
  static of(value: DecimalInput): Price {
    const d = toDecimal(value, 'Price');
    if (d.isNegative()) throw new DomainError('INVALID_DECIMAL', `preço negativo: ${d.toString()}`);
    if (d.decimalPlaces() > PRICE_MAX_SCALE) {
      throw new DomainError(
        'INVALID_SCALE',
        `preço com mais de ${PRICE_MAX_SCALE} casas: ${d.toString()}`,
      );
    }
    return new Price(d);
  }

  /** Preço de negociação: positivo e com até 4 casas. */
  static trading(value: DecimalInput): Price {
    const p = Price.of(value);
    if (p.value.isZero())
      throw new DomainError('INVALID_DECIMAL', 'preço de negociação precisa ser maior que zero');
    if (p.value.decimalPlaces() > TRADING_PRICE_MAX_SCALE) {
      throw new DomainError(
        'INVALID_SCALE',
        `preço de negociação com mais de ${TRADING_PRICE_MAX_SCALE} casas`,
      );
    }
    return p;
  }

  /**
   * Ajusta ao múltiplo de `tick` com direção explícita (ex.: FMS e trailing stop usam CEIL/FLOOR
   * conforme o lado, para ficar do lado conservador).
   */
  roundToTick(tick: DecimalInput, mode: RoundingMode): Price {
    const t = toDecimal(tick, 'tick');
    if (!t.isPositive() || t.isZero())
      throw new DomainError('INVALID_DECIMAL', 'tick precisa ser maior que zero');
    const ticks = roundDecimal(this.value.dividedBy(t), 0, mode);
    return new Price(ticks.times(t));
  }

  round(scale: number, mode: RoundingMode): Price {
    return new Price(roundDecimal(this.value, scale, mode));
  }

  equals(other: Price): boolean {
    return this.value.equals(other.value);
  }

  compare(other: Price): -1 | 0 | 1 {
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }

  /** String com ao menos 2 casas (`"38.50"`). */
  toString(): string {
    return this.value.toFixed(Math.max(2, this.value.decimalPlaces()));
  }

  toJSON(): string {
    return this.toString();
  }
}
