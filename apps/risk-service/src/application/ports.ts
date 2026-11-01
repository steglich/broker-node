import type { Decimal, Instant } from '@broker/domain-kernel';
import type { Hold, ReferenceType } from '../domain/holds.js';
import type { Classification, Figures, RejectCode } from '../domain/pretrade.js';
import type { AccountProjection, Side, UnbookedTrade } from '../domain/projection.js';

export interface PreTradeResponse {
  decision: 'APPROVED' | 'REJECTED';
  holdId?: string;
  classification?: Classification;
  rejectCode?: RejectCode;
  figures?: Figures;
}

/** Linha de `risk_trade`: o que o trade bust precisa desfazer e o que casa com o ledger. */
export interface TradeRow extends Omit<UnbookedTrade, 'instrumentId'> {
  accountId: string;
  instrumentId: string | null;
  executed: boolean;
  busted: boolean;
}

export interface HoldEventPayload {
  holdId: string;
  accountId: string;
  type: Hold['type'];
  resource: string;
  amount: string;
  quantity?: number;
  reference: { type: string; id: string };
}

/** Eventos que o Risco publica pela outbox (Risco §12), particionados por `account_id`. */
export type RiskEvent =
  | {
      type:
        'risk.hold_created' | 'risk.hold_adjusted' | 'risk.hold_released' | 'risk.hold_consumed';
      payload: HoldEventPayload;
    }
  | {
      type: 'risk.pretrade_approved';
      payload: {
        requestId: string;
        accountId: string;
        orderId: string;
        holdId: string;
        classification: Classification;
        figures: Figures;
      };
    }
  | {
      type: 'risk.pretrade_rejected';
      payload: {
        requestId: string;
        accountId: string;
        orderId: string;
        classification?: Classification;
        rejectCode: RejectCode;
        figures?: Figures;
      };
    }
  | {
      type: 'risk.buying_power_changed';
      payload: { accountId: string; cash: string; asOf: string };
    };

/** Unidade de trabalho: tudo numa transação do banco do serviço, com a outbox. */
export interface RiskTx {
  /** `false` se outra instância já foi eleita depois desta época (D14). */
  holdsEpoch(epoch: number): Promise<boolean>;

  /** Cria a linha se preciso e a trava: serializa os eventos da conta. */
  lockAccount(accountId: string): Promise<void>;
  loadAccount(accountId: string): Promise<AccountProjection>;
  saveBalances(p: AccountProjection): Promise<void>;
  saveStatus(p: AccountProjection): Promise<void>;
  savePosition(p: AccountProjection, instrumentId: string): Promise<void>;

  trade(tradeId: string, side: Side): Promise<TradeRow | null>;
  /** As pontas conhecidas do negócio, para o trade bust. */
  tradeSides(tradeId: string): Promise<TradeRow[]>;
  saveTrade(t: TradeRow): Promise<void>;
  /** Marca os custos das pontas até a data: a nota já foi lançada no ledger. */
  bookFees(accountId: string, upTo: string): Promise<void>;

  hold(id: string, opts?: { forUpdate?: boolean }): Promise<Hold | null>;
  holdOfReference(type: ReferenceType, id: string, holdType: Hold['type']): Promise<Hold | null>;
  saveHold(h: Hold): Promise<void>;

  /** Registra a referência como aberta; `false` se ela já terminou. */
  openReference(type: ReferenceType, id: string, accountId: string): Promise<boolean>;
  closeReference(
    type: ReferenceType,
    id: string,
    accountId: string,
    status: string,
    at: Instant,
  ): Promise<void>;
  /** Holds `ACTIVE` cuja referência terminou até `before` (RN-HLD-007). */
  orphanHolds(before: Instant, limit: number): Promise<{ id: string; accountId: string }[]>;

  decision(requestId: string): Promise<PreTradeResponse | null>;
  saveDecision(
    requestId: string,
    accountId: string,
    response: PreTradeResponse,
    at: Instant,
  ): Promise<void>;

  /** `false` se o preço é mais velho que o já conhecido. */
  savePrice(instrumentId: string, price: Decimal, seq: number): Promise<boolean>;

  publish(event: RiskEvent, partitionKey: string): Promise<void>;
}

/** Transação com commit explícito: quem decide faz o commit ainda na vez da conta. */
export interface RiskUnit {
  tx: RiskTx;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface RiskStore {
  transaction<T>(fn: (tx: RiskTx) => Promise<T>): Promise<T>;
  /** Abre a transação já com a conexão do pool na mão. */
  begin(): Promise<RiskUnit>;
  /** Sobe a época e devolve a nova: daqui em diante, só esta instância escreve holds. */
  bumpEpoch(): Promise<number>;
  /** Tudo o que a memória precisa ao assumir (Cache e retenção §2). */
  loadAll(): Promise<{
    accounts: AccountProjection[];
    prices: { instrumentId: string; price: Decimal; seq: number }[];
  }>;
}

/** Alerta da reconciliação de holds (RN-HLD-007): log com severidade e aviso (testes). */
export interface OrphanHoldAlert {
  kind: 'ORPHAN_HOLD';
  holdId: string;
  accountId: string;
  referenceType: string;
  referenceId: string;
  amount: string;
}
