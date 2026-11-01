import type { Decimal, Instant } from '@broker/domain-kernel';
import type { SmmParams } from '../domain/params.js';
import type { Phase } from '../domain/phases.js';
import type { Position, Side } from '../domain/position.js';
import type { Board, LiveOrder } from '../domain/quotes.js';

/** Linha de `smm_state`: cópia do cadastro, referência, túnel, posição e ofertas vivas. */
export interface InstrumentState {
  id: string;
  symbol: string | null;
  lotSize: number | null;
  tickSize: Decimal | null;
  oddLot: boolean;
  tradable: boolean;
  status: string;
  /** Kill switch do instrumento (RN-SMM-030). */
  enabled: boolean;
  activatedAt: Instant | null;
  initialStock: number;
  /** Fase própria, publicada pela sessão; `null` segue o mercado. */
  ownPhase: Phase | null;
  reference: Decimal | null;
  referenceSeq: number;
  externalQuoteTime: Instant | null;
  /** Última cotação válida e o instante em que o Market Data a declarou defasada (RN-SMM-032). */
  staleSince: Instant | null;
  staleAt: Instant | null;
  stopped: boolean;
  bandReference: Decimal | null;
  rejectionBandPct: Decimal | null;
  position: Position;
  liveOrders: LiveOrder[];
  /** A referência usada na última cotação: é contra ela que o limiar de RN-SMM-010 compara. */
  lastReference: Decimal | null;
  lastRequoteAt: Instant | null;
  spreadMultiplier: number;
  bestBid: Decimal | null;
  bestAsk: Decimal | null;
  requotes: number;
  quotedMs: number;
  quotedSince: Instant | null;
}

export interface Control {
  marketPhase: Phase;
  globalEnabled: boolean;
}

export interface BookLevel {
  side: Side;
  price: Decimal;
  quantity: number;
}

export interface Fill {
  tradeId: string;
  side: Side;
  instrumentId: string;
  quantity: number;
  price: Decimal;
  engineSeq: number;
  executedAt: Instant;
}

export type ChangeRequestType = 'SMM_ENABLE' | 'SMM_PARAMETERS';
export type ChangeRequestStatus =
  'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELED' | 'STALE';

export interface ChangeRequest {
  id: string;
  type: ChangeRequestType;
  payload: Record<string, unknown>;
  /** Foto do que a aprovação compara (RN-MC-BO-003). */
  currentState: string;
  justification: string;
  makerId: string;
  status: ChangeRequestStatus;
  createdAt: Instant;
  expiresAt: Instant;
  decidedBy: string | null;
  decidedAt: Instant | null;
  decisionReason: string | null;
}

/** Eventos e comandos que o FMS publica pela outbox (Catálogo de serviços §10). */
export type SmmEvent =
  | {
      type: 'engine.new_order';
      payload: {
        instrumentId: string;
        orderId: string;
        accountId: string;
        participantType: 'MARKET_MAKER';
        board: Board;
        side: Side;
        type: 'LIMIT';
        quantity: number;
        limitPrice: string;
        timeInForce: 'DAY' | 'IOC';
        stpPolicy: 'CANCEL_AGGRESSOR';
      };
    }
  | {
      type: 'engine.cancel_order';
      payload: { instrumentId: string; orderId: string; reason: string };
    }
  | {
      type: 'smm.status_changed';
      payload: {
        scope: string;
        status: 'ON' | 'OFF' | 'STOPPED';
        reason: string;
        actorId: string;
        approvalRequestId: string | null;
      };
    }
  | {
      type: 'smm.metrics';
      payload: {
        instrumentId: string;
        inventory: number;
        realizedPnl: string;
        unrealizedPnl: string | null;
        volume: number;
        requotes: number;
        effectiveSpreadBps: string | null;
        quotedSeconds: number;
        bestBid: string | null;
        bestAsk: string | null;
        at: string;
      };
    }
  | {
      type: 'smm.instrument_activated';
      payload: {
        instrumentId: string;
        symbol: string;
        accountId: string;
        initialStock: number;
        activatedAt: string;
      };
    };

/** Unidade de trabalho: tudo numa transação do banco do serviço, com a outbox. */
export interface SmmTx {
  control(): Promise<Control>;
  /** Trava a linha: serializa o kill switch global e as mudanças de fase do mercado. */
  lockControl(): Promise<Control>;
  saveControl(c: Control): Promise<void>;

  /** Cria a linha se preciso e a trava: serializa tudo o que mexe num instrumento. */
  lockInstrument(id: string): Promise<InstrumentState>;
  instrument(id: string): Promise<InstrumentState | null>;
  /** Ids em ordem: quem trava vários instrumentos sempre trava na mesma ordem. */
  instrumentIds(): Promise<string[]>;
  saveInstrument(i: InstrumentState): Promise<void>;

  paramsAt(instrumentId: string, at: Instant): Promise<SmmParams>;
  /** `false` se a vigência já existia (reentrega do evento). */
  insertParams(p: {
    id: string;
    instrumentId: string | null;
    params: Partial<SmmParams>;
    validFrom: Instant;
    approvalRequestId: string | null;
  }): Promise<boolean>;

  /** Delta do livro principal; `false` se o `engine_seq` já foi visto (RN-REC-002). */
  applyBookChange(input: {
    instrumentId: string;
    engineSeq: number;
    side: Side;
    price: Decimal;
    quantity: number;
  }): Promise<boolean>;
  bookLevels(instrumentId: string): Promise<BookLevel[]>;

  /** `false` se a ponta já foi registrada (reentrega do negócio). */
  insertFill(f: Fill): Promise<boolean>;
  /** Marca as pontas do negócio como canceladas; `false` se não havia ponta viva. */
  bustFills(tradeId: string): Promise<boolean>;
  /** Pontas vivas, na ordem em que aconteceram. */
  fills(instrumentId: string): Promise<Fill[]>;

  insertChangeRequest(r: ChangeRequest): Promise<void>;
  saveChangeRequest(r: ChangeRequest): Promise<void>;
  changeRequest(id: string, opts?: { forUpdate?: boolean }): Promise<ChangeRequest | null>;
  changeRequests(status: ChangeRequestStatus | undefined, limit: number): Promise<ChangeRequest[]>;
  duePendingRequests(now: Instant, limit: number): Promise<ChangeRequest[]>;

  publish(event: SmmEvent, partitionKey: string): Promise<void>;
}

export interface SmmStore {
  transaction<T>(fn: (tx: SmmTx) => Promise<T>): Promise<T>;
}
