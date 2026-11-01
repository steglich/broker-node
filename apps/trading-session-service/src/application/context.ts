import type { TradingCalendar } from '@broker/calendar';
import type { Clock } from '@broker/clock';
import type { Logger } from '@broker/service-kit';
import type { AuctionExtensionPolicy } from '../domain/auction.js';
import type { SessionStore } from './ports.js';

export interface SessionParams {
  /** RN-AUC-003: máximo de prorrogações e o que fazer depois (`auction_extension_policy`). */
  maxAuctionExtensions: number;
  auctionExtensionPolicy: AuctionExtensionPolicy;
  /** RN-CB-002: minutos antes do fim do contínuo sem circuit breaker automático. */
  circuitBreakerBlackoutMinutes: number;
  /** RN-FCH-003: `close_divergence_alert_pct`, em fração. */
  closeDivergenceAlertPct: string;
  /** Pregão §5: minutos sem nada do Market Data até suspender; 0 desliga. */
  marketDataOutageMinutes: number;
  /** Prazo das solicitações de aprovação (RN-MC-BO-001). */
  requestTtlHours: number;
}

export const DEFAULT_SESSION_PARAMS: SessionParams = {
  maxAuctionExtensions: 3,
  auctionExtensionPolicy: 'CONCLUDE_AT_BAND',
  circuitBreakerBlackoutMinutes: 30,
  closeDivergenceAlertPct: '0.05',
  marketDataOutageMinutes: 10,
  requestTtlHours: 24,
};

export interface SessionDeps {
  store: SessionStore;
  clock: Clock;
  calendar: TradingCalendar;
  newId: () => string;
  logger: Logger;
  params: SessionParams;
}

/** Erro de caso de uso, traduzido pelo adaptador HTTP em Problem Details. */
export class SessionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Recurso inexistente.') => new SessionError(404, 'NOT_FOUND', what);
export const rule = (code: string, message: string, context?: Record<string, unknown>) =>
  new SessionError(422, code, message, context);

export const SYSTEM = 'trading-session-service';
