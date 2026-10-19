import type { Decimal as DecimalJs } from 'decimal.js';
import { Decimal } from './decimal.js';

/**
 * Modos de arredondamento do domínio (ADR-0004). Sempre explícitos.
 * - HALF_UP: padrão a 2 casas por componente (custos, IR, notas; RN-FEE-030)
 * - TRUNCATE: corta em direção ao zero (proventos por conta; RN-CA-022)
 * - CEIL / FLOOR: direção conservadora explícita (ticks do FMS, trailing stop)
 */
export type RoundingMode = 'HALF_UP' | 'TRUNCATE' | 'CEIL' | 'FLOOR';

const MODES: Record<RoundingMode, DecimalJs.Rounding> = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  TRUNCATE: Decimal.ROUND_DOWN,
  CEIL: Decimal.ROUND_CEIL,
  FLOOR: Decimal.ROUND_FLOOR,
};

export const roundDecimal = (value: Decimal, scale: number, mode: RoundingMode): Decimal =>
  value.toDecimalPlaces(scale, MODES[mode]);
