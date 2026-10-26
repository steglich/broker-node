import type { TradingCalendar } from '@broker/calendar';
import type { Clock } from '@broker/clock';
import type { Logger } from '@broker/service-kit';
import type { DepositRules } from '../domain/deposit.js';
import type { WithdrawalRules } from '../domain/withdrawal.js';
import type {
  CriticalLedgerAlert,
  CustomerDirectory,
  LedgerStore,
  PixGateway,
  RiskHoldPort,
  TaxIdHasher,
} from './ports.js';

export interface LedgerDeps {
  store: LedgerStore;
  clock: Clock;
  calendar: TradingCalendar;
  newId: () => string;
  logger: Logger;
  pix: PixGateway;
  customers: CustomerDirectory;
  holds: RiskHoldPort;
  taxIds: TaxIdHasher;
  depositRules: DepositRules;
  withdrawalRules: WithdrawalRules;
  onCriticalAlert?: (alert: CriticalLedgerAlert) => void;
}

/** Erro de caso de uso, traduzido pelo adaptador HTTP em Problem Details. */
export class LedgerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Recurso inexistente.') => new LedgerError(404, 'NOT_FOUND', what);
export const rule = (code: string, message: string, context?: Record<string, unknown>) =>
  new LedgerError(422, code, message, context);
export const unavailable = (code: string, message: string) => new LedgerError(503, code, message);

/** Quem age numa rota autenticada. */
export interface Caller {
  userId: string;
  accountId?: string;
}

export interface Operator {
  id: string;
  roles: readonly string[];
}

export const SYSTEM = 'ledger-service';
