import type { Clock } from '@broker/clock';
import type { Logger } from '@broker/service-kit';
import type { SmmStore } from './ports.js';

export interface SmmDeps {
  store: SmmStore;
  clock: Clock;
  newId: () => string;
  logger: Logger;
  /** A conta `MARKET_MAKER` do FMS (RN-SMM-022): não passa por Risco, custos nem IR. */
  accountId: string;
  /** Prazo das solicitações de aprovação (RN-MC-BO-001). */
  requestTtlHours: number;
}

/** Erro de caso de uso, traduzido pelo adaptador HTTP em Problem Details. */
export class SmmError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Recurso inexistente.') => new SmmError(404, 'NOT_FOUND', what);
export const rule = (code: string, message: string, context?: Record<string, unknown>) =>
  new SmmError(422, code, message, context);

export const SYSTEM = 'market-maker-service';
