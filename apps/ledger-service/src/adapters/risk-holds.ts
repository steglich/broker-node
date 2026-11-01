import type { Money } from '@broker/domain-kernel';
import type { RpcClient } from '@broker/service-kit';
import type { LedgerStore, RiskHoldPort } from '../application/ports.js';

interface CreateHoldResult {
  decision: 'APPROVED' | 'REJECTED';
  rejectCode?: string;
}

/**
 * Holds no risk-service (Contratos §10.2, D11): quem serializa o saldo da conta é o Risco
 * (RN-LED-030, ADR-0003). O id escolhido aqui é o `requestId`, e também o `hold_id`: mesmo se a resposta
 * se perder, o ledger consegue liberar. Fora do ar, o `RpcClient` lança `503 RISK_UNAVAILABLE`.
 *
 * `activeHolds` não chama o Risco: lê a cópia alimentada por `risk.hold_*`, porque entra no cálculo
 * de saldo de todo lançamento.
 */
export class RpcRiskHoldPort implements RiskHoldPort {
  constructor(private readonly o: { rpc: Pick<RpcClient, 'call'>; store: LedgerStore }) {}

  async createHold(input: { holdId: string; accountId: string; amount: Money }) {
    const res = await this.o.rpc.call<CreateHoldResult>({
      method: 'POST',
      path: '/v1/internal/risk/holds',
      idempotencyKey: input.holdId,
      body: {
        requestId: input.holdId,
        holdType: 'WITHDRAWAL',
        accountId: input.accountId,
        amount: input.amount.round('HALF_UP').amount.toFixed(2),
        reference: { type: 'WITHDRAWAL', id: input.holdId },
      },
    });
    return res.body.decision === 'APPROVED'
      ? { approved: true as const }
      : { approved: false as const, code: 'INSUFFICIENT_WITHDRAWABLE_BALANCE' as const };
  }

  consumeHold(holdId: string) {
    return this.settle(holdId, 'CONSUMED');
  }

  releaseHold(holdId: string) {
    return this.settle(holdId, 'CANCELED');
  }

  activeHolds(accountId: string) {
    return this.o.store.transaction((tx) => tx.heldAmount(accountId));
  }

  private async settle(holdId: string, outcome: 'CONSUMED' | 'CANCELED') {
    await this.o.rpc.call({
      method: 'POST',
      path: `/v1/internal/risk/holds/${holdId}/release`,
      idempotencyKey: `${holdId}:${outcome}`,
      body: { outcome },
    });
  }
}
