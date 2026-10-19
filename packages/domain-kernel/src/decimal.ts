import { Decimal as DecimalJs } from 'decimal.js';
import { DomainError } from './errors.js';

/**
 * Decimal do domínio: 34 dígitos significativos (ADR-0004, D5). Arredondamento padrão da
 * biblioteca fica em ROUND_HALF_UP, mas o domínio sempre passa o modo explicitamente.
 */
export const Decimal = DecimalJs.clone({ precision: 34, rounding: DecimalJs.ROUND_HALF_UP });
export type Decimal = InstanceType<typeof Decimal>;

/** Entrada decimal aceita: string decimal, bigint ou outro Decimal. `number` é recusado. */
export type DecimalInput = string | bigint | Decimal;

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Converte para Decimal. `number` é recusado mesmo em JavaScript sem tipos: ponto flutuante
 * binário não representa valores decimais com exatidão (ADR-0004).
 */
export function toDecimal(value: DecimalInput, what = 'valor'): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === 'bigint') return new Decimal(value.toString());
  if (typeof value === 'string' && DECIMAL_PATTERN.test(value)) return new Decimal(value);
  if (typeof value === 'number') {
    throw new DomainError(
      'INVALID_DECIMAL',
      `${what} não pode ser construído a partir de number (ponto flutuante); use string decimal`,
    );
  }
  throw new DomainError('INVALID_DECIMAL', `${what} inválido: ${String(value)}`);
}

/** Número de casas decimais efetivas (sem zeros à direita). */
export const scaleOf = (d: Decimal): number => d.decimalPlaces();
