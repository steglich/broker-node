import type { BusinessDate, Decimal, Instant } from '@broker/domain-kernel';
import type { AuctionStatus, AuctionType, PriceLimit } from '../domain/auction.js';
import type { CloseSource } from '../domain/closing.js';
import type { Phase } from '../domain/phases.js';
import type { SessionRules } from '../domain/trading-rules.js';

export interface MarketState {
  phase: Phase;
  /** A fase da grade: `phase` difere dela em suspensão e reabertura. */
  scheduledPhase: Phase;
  since: Instant;
  expectedEndAt: Instant | null;
  reason: string;
  businessDate: BusinessDate | null;
}

export interface InstrumentState {
  id: string;
  symbol: string;
  tradable: boolean;
  status: string;
  /** Fase própria; `null` segue o mercado. */
  phase: Phase | null;
  since: Instant | null;
  expectedEndAt: Instant | null;
  reason: string | null;
  enginePhase: Phase | null;
  previousClose: Decimal | null;
  bandReferencePrice: Decimal | null;
  lastTradePrice: Decimal | null;
  lastTradeDate: BusinessDate | null;
  lastTradeSeq: bigint | null;
  externalPrice: Decimal | null;
  externalQuoteTime: Instant | null;
}

export interface Halt {
  id: string;
  scope: string;
  reasonCode: string;
  description: string | null;
  startedAt: Instant;
  endedAt: Instant | null;
  resumeAt: Instant | null;
  resumeAuctionS: number;
  cancelAllOnHalt: boolean;
  actorId: string;
  approvalRequestId: string | null;
}

export interface Auction {
  id: string;
  instrumentId: string;
  type: AuctionType;
  status: AuctionStatus;
  marketScoped: boolean;
  businessDate: BusinessDate;
  startedAt: Instant;
  expectedEndAt: Instant;
  effectiveEndAt: Instant | null;
  extensions: number;
  theoreticalPrice: Decimal | null;
  theoreticalQuantity: bigint | null;
  price: Decimal | null;
  quantity: bigint | null;
}

export interface CircuitBreakerEvent {
  id: string;
  businessDate: BusinessDate;
  level: number;
  indexChange: Decimal | null;
  origin: 'INDEX' | 'BACKOFFICE' | 'SANDBOX';
  triggeredAt: Instant;
  resumesAt: Instant;
}

export interface ClosingPrice {
  instrumentId: string;
  businessDate: BusinessDate;
  price: Decimal;
  source: CloseSource;
  externalClose: Decimal | null;
  divergenceAlert: boolean;
}

export interface MarketWatch {
  indexLast: Decimal | null;
  indexPreviousClose: Decimal | null;
  indexQuoteTime: Instant | null;
  lastMarketDataAt: Instant | null;
  budgetLevel: string;
}

export interface SessionAlert {
  id: string;
  kind: string;
  dedupeKey: string;
  message: string;
  data: Record<string, unknown>;
  createdAt: Instant;
}

export type ChangeRequestType = 'MARKET_HALT' | 'MARKET_RESUME' | 'CIRCUIT_BREAKER';
export type ChangeRequestStatus =
  'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELED' | 'STALE';

export interface ChangeRequest {
  id: string;
  type: ChangeRequestType;
  payload: Record<string, unknown>;
  currentState: Record<string, unknown>;
  justification: string;
  makerId: string;
  status: ChangeRequestStatus;
  createdAt: Instant;
  expiresAt: Instant;
  decidedBy: string | null;
  decidedAt: Instant | null;
  decisionReason: string | null;
}

export interface PhaseChangeCommand {
  scope: string;
  phase: Phase;
  auctionId?: string;
  auctionType?: AuctionType;
  auctionEndAt?: string;
  randomSeed?: string;
  concludesAuctionId?: string;
  priceLimit?: PriceLimit;
}

/** Eventos e comandos que a sessão publica pela outbox (Catálogo §4 e §6). */
export type SessionEvent =
  | {
      type: 'session.trading_day_opened' | 'session.trading_day_closed';
      payload: { businessDate: string };
    }
  | {
      type: 'session.phase_changed';
      payload: {
        scope: string;
        from: Phase;
        to: Phase;
        reason: string;
        effectiveAt: string;
        expectedEndAt: string | null;
        auctionId?: string;
      };
    }
  | {
      type: 'session.halt_started';
      payload: {
        haltId: string;
        scope: string;
        reasonCode: string;
        cancelAllOnHalt: boolean;
        resumesAt: string | null;
      };
    }
  | { type: 'session.halt_ended'; payload: { haltId: string; scope: string; reasonCode: string } }
  | {
      type: 'session.circuit_breaker_triggered';
      payload: {
        level: number;
        indexChangePercent: string | null;
        resumesAt: string;
        origin: 'INDEX' | 'BACKOFFICE' | 'SANDBOX';
      };
    }
  | { type: 'engine.phase_change'; payload: PhaseChangeCommand }
  | {
      type: 'engine.band_update';
      payload: {
        instrumentId: string;
        bandReferencePrice: string;
        rejectionBandPct: string;
        staticAuctionBandPct: string;
        dynamicAuctionBandPct: string;
        volatilityAuctionDurationS: number;
        auctionRandomEndMaxS: number;
      };
    }
  | {
      type: 'routine.completed';
      payload: {
        routineName: string;
        businessDate: string;
        executionId: string;
        stats?: Record<string, unknown>;
      };
    };

/** Unidade de trabalho: tudo numa transação do banco do serviço, com a outbox. */
export interface SessionTx {
  /** Lê o estado do mercado travando a linha: serializa as mudanças de fase. */
  lockMarket(): Promise<MarketState>;
  market(): Promise<MarketState>;
  saveMarket(m: MarketState): Promise<void>;

  instrument(id: string, opts?: { forUpdate?: boolean }): Promise<InstrumentState | null>;
  instrumentBySymbol(symbol: string): Promise<InstrumentState | null>;
  tradableInstruments(): Promise<InstrumentState[]>;
  /** Cria com a cópia do reference-data, ou atualiza só `symbol`, `tradable` e `status`. */
  upsertInstrumentCopy(i: {
    id: string;
    symbol: string;
    tradable: boolean;
    status: string;
  }): Promise<void>;
  saveInstrument(i: InstrumentState): Promise<void>;
  /** Último negócio do contínuo, em ordem de `engine_seq`. */
  recordContinuousTrade(input: {
    instrumentId: string;
    price: Decimal;
    tradingDate: BusinessDate;
    engineSeq: bigint;
  }): Promise<void>;

  tradingDay(date: BusinessDate): Promise<{ status: string } | null>;
  openTradingDay(date: BusinessDate, at: Instant): Promise<void>;
  closeTradingDay(date: BusinessDate, at: Instant): Promise<void>;
  insertTransition(t: {
    id: string;
    scope: string;
    from: Phase;
    to: Phase;
    reason: string;
    effectiveAt: Instant;
    actor: string;
  }): Promise<void>;

  /** `false` se já havia suspensão ativa com o mesmo escopo e motivo. */
  insertHalt(h: Halt): Promise<boolean>;
  saveHalt(h: Halt): Promise<void>;
  halt(id: string): Promise<Halt | null>;
  activeHalts(scope?: string): Promise<Halt[]>;
  halts(opts: { active?: boolean; limit: number }): Promise<Halt[]>;

  insertAuction(a: Auction): Promise<void>;
  saveAuction(a: Auction): Promise<void>;
  auction(id: string, opts?: { forUpdate?: boolean }): Promise<Auction | null>;
  /** Leilões `OPEN` ou `HELD`, de um instrumento ou todos. */
  liveAuctions(instrumentId?: string): Promise<Auction[]>;
  /** Teórico mais recente (RN-AUC-002); ignora leilão já encerrado. */
  recordIndicative(input: {
    auctionId: string;
    price: Decimal | null;
    quantity: bigint;
  }): Promise<void>;

  circuitBreakerEvents(date: BusinessDate): Promise<CircuitBreakerEvent[]>;
  insertCircuitBreaker(e: CircuitBreakerEvent): Promise<void>;

  completedClosingCall(instrumentId: string, date: BusinessDate): Promise<Auction | null>;
  upsertClosingPrice(c: ClosingPrice): Promise<void>;
  closingPrice(instrumentId: string, date: BusinessDate): Promise<ClosingPrice | null>;
  closingPrices(date: BusinessDate): Promise<ClosingPrice[]>;

  routine(
    name: string,
    date: BusinessDate,
  ): Promise<{
    executionId: string;
    status: 'PENDING' | 'COMPLETED';
    stats: Record<string, unknown>;
  } | null>;
  saveRoutine(r: {
    name: string;
    date: BusinessDate;
    executionId: string;
    status: 'PENDING' | 'COMPLETED';
    stats: Record<string, unknown>;
  }): Promise<void>;

  /** Vigentes em `at`: o global (`instrumentId` nulo) e a sobrescrita, se houver. */
  rulesAt(instrumentId: string, at: Instant): Promise<SessionRules>;
  insertRuleVersion(r: {
    ruleId: string;
    instrumentId: string | null;
    rules: Partial<SessionRules>;
    validFrom: Instant;
  }): Promise<void>;

  watch(): Promise<MarketWatch>;
  saveIndex(input: { last: Decimal; previousClose: Decimal; quoteTime: Instant }): Promise<void>;
  touchMarketData(at: Instant): Promise<void>;
  saveBudgetLevel(level: string): Promise<void>;

  /** `false` se o alerta (`dedupeKey`) já existia. */
  insertAlert(a: SessionAlert): Promise<boolean>;
  alerts(limit: number): Promise<SessionAlert[]>;

  insertChangeRequest(r: ChangeRequest): Promise<void>;
  saveChangeRequest(r: ChangeRequest): Promise<void>;
  changeRequest(id: string, opts?: { forUpdate?: boolean }): Promise<ChangeRequest | null>;
  changeRequests(status: ChangeRequestStatus | undefined, limit: number): Promise<ChangeRequest[]>;
  duePendingRequests(now: Instant, limit: number): Promise<ChangeRequest[]>;

  publish(event: SessionEvent, partitionKey: string): Promise<void>;
}

export interface SessionStore {
  transaction<T>(fn: (tx: SessionTx) => Promise<T>): Promise<T>;
}
