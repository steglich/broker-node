import { Decimal } from '@broker/domain-kernel';
import { settleHold, type Hold, type HoldType } from '../domain/holds.js';
import { decidePreTrade, decideWithdrawal, type Figures } from '../domain/pretrade.js';
import { buyingPower } from '../domain/projection.js';
import { RiskUnavailableError, saveAndPublishHold, type RiskDeps } from './context.js';
import type { PreTradeResponse, RiskTx } from './ports.js';

/** Espera depois de a referência terminar: a última execução pode estar a caminho (premissa do README). */
const ORPHAN_GRACE_MS = 60_000;
const ORPHAN_BATCH = 200;

export interface PreTradeRequest {
  requestId: string;
  accountId: string;
  orderId: string;
  instrumentId: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  referencePrice: string;
  tradeIntent: 'NORMAL' | 'DAY_TRADE';
  operation: 'NEW' | 'REPLACE';
}

export interface CreateHoldRequest {
  requestId: string;
  accountId: string;
  amount: string;
  referenceId: string;
}

export type CreateHoldResponse =
  | { decision: 'APPROVED'; holdId: string }
  | { decision: 'REJECTED'; rejectCode: string; figures: Figures };

/**
 * As decisões síncronas: pré-trade e holds de saque, em série por conta (RN-RSK-001). O hold é gravado
 * com a outbox antes da resposta, e a memória só muda depois do commit. Quem decide é só a instância
 * eleita.
 */
export class Decisions {
  /** Época da liderança; `null` em espera ou reconstruindo. */
  private epoch: number | null = null;

  constructor(private readonly d: RiskDeps) {}

  open(epoch: number): void {
    this.epoch = epoch;
  }

  close(): void {
    this.epoch = null;
  }

  isOpen(): boolean {
    return this.epoch !== null;
  }

  private epochOrFail(): number {
    if (this.epoch === null)
      throw new RiskUnavailableError('projeção indisponível nesta instância');
    return this.epoch;
  }

  private async assertLeader(tx: RiskTx, epoch: number): Promise<void> {
    if (await tx.holdsEpoch(epoch)) return;
    this.close();
    throw new RiskUnavailableError('outra instância assumiu a liderança');
  }

  /** Leitura e publicação fora da fila de uma conta, ainda sob a cerca. */
  private fenced<T>(work: (tx: RiskTx) => Promise<T>): Promise<T> {
    const epoch = this.epochOrFail();
    return this.d.store.transaction(async (tx) => {
      await this.assertLeader(tx, epoch);
      return work(tx);
    });
  }

  /**
   * Decide na vez da conta. A conexão vem antes da fila: quem está na vez nunca espera o pool. Do
   * contrário, a vez ficaria presa esperando uma conexão, e as conexões, presas em eventos que esperam
   * a linha de outro evento, que por sua vez espera esta vez. O commit ainda é na vez, e `onCommit` muda
   * a memória logo depois: quem vem a seguir já vê o hold.
   */
  private async decide<T>(
    accountId: string,
    work: (tx: RiskTx, onCommit: (apply: () => void) => void) => Promise<T>,
  ): Promise<T> {
    const epoch = this.epochOrFail();
    const unit = await this.d.store.begin();
    try {
      return await this.d.memory.inTurn(accountId, async () => {
        await this.assertLeader(unit.tx, epoch);
        let apply: (() => void) | undefined;
        const result = await work(unit.tx, (fn) => (apply = fn));
        await unit.commit();
        apply?.();
        return result;
      });
    } catch (err) {
      await unit.rollback().catch(() => undefined);
      throw err;
    }
  }

  /** Sequência do Risco §11, com a decisão pura em `domain/pretrade.ts`. */
  preTrade(input: PreTradeRequest): Promise<PreTradeResponse> {
    return this.decide(input.accountId, async (tx, onCommit): Promise<PreTradeResponse> => {
      const known = await tx.decision(input.requestId);
      if (known) return known;
      const now = this.d.clock.now();
      const p = this.d.memory.account(input.accountId);
      const type: HoldType = input.side === 'BUY' ? 'ORDER_CASH' : 'ORDER_POSITION';
      const existing = await tx.holdOfReference('ORDER', input.orderId, type);
      const active = existing?.status === 'ACTIVE' ? existing : null;
      // Pedido novo repetido com outro `requestId`: a ordem já tem a reserva dela.
      if (input.operation === 'NEW' && active) return { decision: 'APPROVED', holdId: active.id };

      const decision = decidePreTrade(
        p,
        { ...input, referencePrice: new Decimal(input.referencePrice) },
        active,
      );
      if (decision.decision === 'REJECTED') {
        const rejected: PreTradeResponse = {
          decision: 'REJECTED',
          rejectCode: decision.rejectCode,
          ...(decision.classification ? { classification: decision.classification } : {}),
          ...(decision.figures ? { figures: decision.figures } : {}),
        };
        await tx.saveDecision(input.requestId, input.accountId, rejected, now);
        await tx.publish(
          {
            type: 'risk.pretrade_rejected',
            payload: {
              requestId: input.requestId,
              accountId: input.accountId,
              orderId: input.orderId,
              rejectCode: decision.rejectCode,
              ...(decision.classification ? { classification: decision.classification } : {}),
              ...(decision.figures ? { figures: decision.figures } : {}),
            },
          },
          input.accountId,
        );
        return rejected;
      }

      const hold: Hold = {
        id: existing?.id ?? this.d.newId(),
        accountId: input.accountId,
        type,
        resource: input.side === 'BUY' ? 'CASH' : input.instrumentId,
        originalAmount: decision.amount,
        remainingAmount: decision.amount,
        originalQuantity: input.quantity,
        remainingQuantity: input.quantity,
        referenceType: 'ORDER',
        referenceId: input.orderId,
        status: 'ACTIVE',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await saveAndPublishHold(tx, hold, !existing);
      const open = await tx.openReference('ORDER', input.orderId, input.accountId);
      const approved: PreTradeResponse = {
        decision: 'APPROVED',
        holdId: hold.id,
        classification: decision.classification,
        figures: decision.figures,
      };
      await tx.saveDecision(input.requestId, input.accountId, approved, now);
      await tx.publish(
        {
          type: 'risk.pretrade_approved',
          payload: {
            requestId: input.requestId,
            accountId: input.accountId,
            orderId: input.orderId,
            holdId: hold.id,
            classification: decision.classification,
            figures: decision.figures,
          },
        },
        input.accountId,
      );
      onCommit(() => {
        p.holds.set(hold.id, hold);
        if (open) p.openOrders.add(input.orderId);
        this.d.memory.put(p);
      });
      return approved;
    });
  }

  /** `CreateHold` de saque: `requestId` é o `hold_id` (RN-LED-030). */
  createHold(input: CreateHoldRequest): Promise<CreateHoldResponse> {
    return this.decide(input.accountId, async (tx, onCommit): Promise<CreateHoldResponse> => {
      if (await tx.hold(input.requestId)) return { decision: 'APPROVED', holdId: input.requestId };
      const amount = new Decimal(input.amount);
      const p = this.d.memory.account(input.accountId);
      const decision = decideWithdrawal(p, amount);
      if (decision.decision === 'REJECTED') return decision;
      const now = this.d.clock.now();
      const hold: Hold = {
        id: input.requestId,
        accountId: input.accountId,
        type: 'WITHDRAWAL',
        resource: 'CASH',
        originalAmount: amount,
        remainingAmount: amount,
        originalQuantity: null,
        remainingQuantity: null,
        referenceType: 'WITHDRAWAL',
        referenceId: input.referenceId,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      };
      await saveAndPublishHold(tx, hold, true);
      await tx.openReference('WITHDRAWAL', input.referenceId, input.accountId);
      onCommit(() => {
        p.holds.set(hold.id, hold);
        this.d.memory.put(p);
      });
      return { decision: 'APPROVED', holdId: hold.id };
    });
  }

  /** `ReleaseHold` (Contratos §10.2). Idempotente: o hold acertado ou desconhecido não muda. */
  async releaseHold(holdId: string, outcome: 'CONSUMED' | 'CANCELED') {
    const known = await this.fenced((tx) => tx.hold(holdId));
    if (!known) return { holdId, status: 'UNKNOWN' as const };
    return this.decide(known.accountId, async (tx, onCommit) => {
      const hold = (await tx.hold(holdId, { forUpdate: true }))!;
      if (hold.status !== 'ACTIVE') return { holdId, status: hold.status };
      const next = settleHold(
        hold,
        outcome === 'CONSUMED' ? 'CONSUMED' : 'RELEASED',
        this.d.clock.now(),
      );
      await saveAndPublishHold(tx, next);
      onCommit(() => this.forget(hold));
      return { holdId, status: next.status };
    });
  }

  private forget(hold: Hold): void {
    const p = this.d.memory.account(hold.accountId);
    p.holds.delete(hold.id);
    this.d.memory.put(p);
  }

  /** Reconciliação de holds órfãos (RN-HLD-007): referência terminal e hold ainda `ACTIVE`. */
  async reconcileOrphans(): Promise<number> {
    const before = this.d.clock.now().plusMillis(-ORPHAN_GRACE_MS);
    const orphans = await this.fenced((tx) => tx.orphanHolds(before, ORPHAN_BATCH));
    let released = 0;
    for (const orphan of orphans) {
      const done = await this.decide(orphan.accountId, async (tx, onCommit) => {
        const h = (await tx.hold(orphan.id, { forUpdate: true }))!;
        if (h.status !== 'ACTIVE') return null;
        await saveAndPublishHold(tx, settleHold(h, 'RELEASED', this.d.clock.now()));
        onCommit(() => this.forget(h));
        return h;
      });
      if (!done) continue;
      released++;
      const alert = {
        kind: 'ORPHAN_HOLD' as const,
        holdId: done.id,
        accountId: done.accountId,
        referenceType: done.referenceType,
        referenceId: done.referenceId,
        amount: done.remainingAmount.toFixed(2),
      };
      this.d.logger.error(
        { event: 'risk.orphan_hold_released', severity: 'critical', ...alert },
        'hold órfão liberado pela reconciliação',
      );
      this.d.onAlert?.(alert);
    }
    return released;
  }

  /** Avisa o poder de compra das contas que mudaram desde a última vez (Risco §12). */
  async publishBuyingPower(): Promise<number> {
    const { memory, clock } = this.d;
    const accounts = [...memory.dirty];
    memory.dirty.clear();
    let published = 0;
    for (const accountId of accounts) {
      const cash = buyingPower(memory.account(accountId)).toFixed(2);
      if (memory.lastPublished.get(accountId) === cash) continue;
      await this.fenced((tx) =>
        tx.publish(
          {
            type: 'risk.buying_power_changed',
            payload: { accountId, cash, asOf: clock.now().toString() },
          },
          accountId,
        ),
      );
      memory.lastPublished.set(accountId, cash);
      published++;
    }
    return published;
  }
}
