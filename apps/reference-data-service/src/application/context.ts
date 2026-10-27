import type { Clock } from '@broker/clock';
import type { Logger } from '@broker/service-kit';
import type { BackofficeAlert, OpenOrdersPort, ReferenceStore } from './ports.js';

export interface ReferenceDeps {
  store: ReferenceStore;
  clock: Clock;
  newId: () => string;
  logger: Logger;
  openOrders: OpenOrdersPort;
  /** RN-INS-011: tamanho máximo do universo negociável (padrão 20). */
  maxTradableInstruments: number;
  /** RN-INS-020: dias úteis sem cotação válida até a suspensão automática (padrão 2). */
  maxQuoteStalenessDays: number;
  /** Prazo das solicitações de aprovação (RN-MC-BO-001, padrão 24 h). */
  requestTtlHours: number;
  /** Sandbox: todo dia é útil (RN-SBX-002). */
  allDaysBusiness: boolean;
  onAlert?: (alert: BackofficeAlert) => void;
}

/** Erro de caso de uso, traduzido pelo adaptador HTTP em Problem Details. */
export class ReferenceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Recurso inexistente.') =>
  new ReferenceError(404, 'NOT_FOUND', what);
export const rule = (code: string, message: string, context?: Record<string, unknown>) =>
  new ReferenceError(422, code, message, context);

export interface Operator {
  id: string;
  roles: readonly string[];
}

export const SYSTEM = 'reference-data-service';
