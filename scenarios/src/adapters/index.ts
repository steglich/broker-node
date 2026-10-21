import type { ScenarioAdapter } from '../runner.js';
import { calAdapter } from './cal.js';
import { feeAdapter } from './fee.js';

/** Adaptadores por prefixo de ID. Cada domínio novo (ME, ORD, RSK, LED…) registra o seu aqui. */
export const adapters: Readonly<Record<string, ScenarioAdapter>> = {
  CAL: calAdapter,
  FEE: feeAdapter,
};
