import type { Board, OrderType, Participant, Side, StpPolicy, TimeInForce } from './book.js';

export type Phase =
  | 'CLOSED'
  | 'PRE_TRADING'
  | 'PRE_OPENING'
  | 'CONTINUOUS'
  | 'CLOSING_CALL'
  | 'POST_CLOSE'
  | 'AFTER_MARKET'
  | 'VOLATILITY_AUCTION'
  | 'HALTED';

export type AuctionType = 'OPENING' | 'CLOSING' | 'VOLATILITY' | 'REOPENING';

export interface NewOrderCommand {
  kind: 'NewOrder';
  orderId: string;
  accountId: string;
  participantType: Participant;
  board: Board;
  side: Side;
  type: OrderType;
  quantity: number;
  limitPrice?: string;
  protectionPrice?: string;
  timeInForce: TimeInForce;
  displayQuantity?: number;
  stpPolicy: StpPolicy;
}

export interface CancelOrderCommand {
  kind: 'CancelOrder';
  orderId: string;
  reason: string;
}

export interface ReplaceOrderCommand {
  kind: 'ReplaceOrder';
  orderId: string;
  newQuantity?: number;
  newLimitPrice?: string;
  expectedVersion: number;
}

export interface PhaseChangeCommand {
  kind: 'PhaseChange';
  phase: Phase;
  auctionId?: string;
  auctionType?: AuctionType;
  auctionEndAt?: string;
  randomSeed?: string;
  concludesAuctionId?: string;
  priceLimit?: { min: string; max: string };
}

export interface BandUpdateCommand {
  kind: 'BandUpdate';
  bandReferencePrice: string;
  rejectionBandPct: string;
  staticAuctionBandPct: string;
  dynamicAuctionBandPct: string;
  volatilityAuctionDurationS: number;
  auctionRandomEndMaxS: number;
}

export interface TradeBustCommand {
  kind: 'TradeBust';
  tradeId: string;
  approvalRequestId: string;
}

export interface NotesCutoffCommand {
  kind: 'NotesCutoff';
  tradingDate: string;
}

/** Só marca a passagem do tempo: é assim que um leilão termina sem nenhum outro comando chegar. */
export interface TickCommand {
  kind: 'Tick';
}

/** Gerada pelo sequenciador na recuperação e gravada no journal: suspende o livro (RN-REC-003). */
export interface RecoveryHaltCommand {
  kind: 'RecoveryHalt';
}

export type EngineCommand =
  | NewOrderCommand
  | CancelOrderCommand
  | ReplaceOrderCommand
  | PhaseChangeCommand
  | BandUpdateCommand
  | TradeBustCommand
  | NotesCutoffCommand
  | TickCommand
  | RecoveryHaltCommand;

/**
 * Uma entrada como foi gravada no journal. Tudo o que o Motor precisa de fora vem aqui, carimbado
 * pelo sequenciador: o tempo, a data do pregão e a semente (RN-ME-002).
 */
export interface EngineInput {
  inputSeq: number;
  /** Relógio do ambiente, em milissegundos desde a época. */
  ts: number;
  tradingDate: string;
  seed: number;
  command: EngineCommand;
}

/** Saída do Motor, antes de virar envelope. `payload` já é o do contrato. */
export interface EngineOutput {
  eventType: string;
  board: Board;
  engineSeq: number;
  inputSeq: number;
  /** Instante da entrada que gerou a saída (o `occurredAt` do envelope). */
  ts: number;
  payload: Record<string, unknown>;
}
