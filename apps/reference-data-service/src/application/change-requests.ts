import type { Instant } from '@broker/domain-kernel';
import {
  assertCanDecide,
  assertMaker,
  isStale,
  type ChangeRequest,
  type ChangeRequestStatus,
  type ChangeRequestType,
} from '../domain/change-request.js';
import { ReferenceRuleError } from '../domain/errors.js';
import { notFound, ReferenceError, rule, type Operator, type ReferenceDeps } from './context.js';
import type { ReferenceTx } from './ports.js';

/** O dono de cada tipo: estado atual (para RN-MC-BO-003), validação e execução. */
export interface ChangeExecutor {
  /** Estado do recurso hoje; mudou desde a criação → `STALE`. */
  currentState(
    tx: ReferenceTx,
    r: Pick<ChangeRequest, 'targetId' | 'payload'>,
  ): Promise<Record<string, unknown>>;
  /** Executa a ação aprovada; idempotente pelo id da solicitação (RN-MC-BO-004). */
  execute(tx: ReferenceTx, r: ChangeRequest): Promise<void>;
}

export interface ChangeRequestView {
  id: string;
  type: ChangeRequestType;
  targetId: string;
  payload: Record<string, unknown>;
  currentState: Record<string, unknown>;
  justification: string;
  makerId: string;
  status: ChangeRequestStatus;
  createdAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
}

export const requestView = (r: ChangeRequest): ChangeRequestView => ({
  ...r,
  createdAt: r.createdAt.toString(),
  expiresAt: r.expiresAt.toString(),
  decidedAt: r.decidedAt?.toString() ?? null,
});

/**
 * Dupla aprovação local (Backoffice §4): `PENDING` → `APPROVED` (executa) | `REJECTED` | `EXPIRED`
 * | `CANCELED` (pelo maker) | `STALE` (o recurso mudou). Na Fase 3 vira o approval-service.
 */
export class ChangeRequests {
  private readonly executors = new Map<ChangeRequestType, ChangeExecutor>();

  constructor(private readonly d: ReferenceDeps) {}

  register(types: readonly ChangeRequestType[], executor: ChangeExecutor): void {
    for (const t of types) this.executors.set(t, executor);
  }

  /** Cria a solicitação com o estado atual; uma pendente por alvo e tipo. */
  async create(
    tx: ReferenceTx,
    op: Operator,
    input: {
      type: ChangeRequestType;
      targetId: string;
      payload: Record<string, unknown>;
      justification: string;
    },
  ): Promise<ChangeRequest> {
    assertMaker(input.type, op);
    if (await tx.pendingFor(input.type, input.targetId))
      throw rule('REQUEST_ALREADY_PENDING', 'Já existe solicitação pendente para este recurso.');
    const now = this.d.clock.now();
    const r: ChangeRequest = {
      id: this.d.newId(),
      type: input.type,
      targetId: input.targetId,
      payload: input.payload,
      currentState: await this.executor(input.type).currentState(tx, input),
      justification: input.justification,
      makerId: op.id,
      status: 'PENDING',
      createdAt: now,
      expiresAt: now.plusMillis(this.d.requestTtlHours * 3_600_000),
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
    };
    await tx.insertChangeRequest(r);
    this.d.logger.info({
      event: 'change_request.created',
      requestId: r.id,
      type: r.type,
      maker: op.id,
    });
    return r;
  }

  async list(status: ChangeRequestStatus | undefined): Promise<ChangeRequestView[]> {
    return this.d.store.transaction(async (tx) =>
      (await tx.changeRequests(status, 200)).map(requestView),
    );
  }

  async get(id: string): Promise<ChangeRequestView> {
    const r = await this.d.store.transaction((tx) => tx.changeRequest(id));
    if (!r) throw notFound('Solicitação inexistente.');
    return requestView(r);
  }

  /**
   * Aprova e executa na mesma transação. Estado mudado → `STALE` sem executar; a execução que
   * recusa por regra (ex.: o universo encheu) também deixa `STALE`, com o motivo.
   */
  async approve(op: Operator, id: string): Promise<ChangeRequestView> {
    const outcome = await this.d.store
      .transaction(async (tx) => {
        const r = await this.locked(tx, id);
        const now = this.d.clock.now();
        assertCanDecide(r, op, now);
        const executor = this.executor(r.type);
        if (isStale(r, await executor.currentState(tx, r)))
          return this.stale(tx, r, op, now, 'O recurso mudou desde a criação da solicitação.');
        const approved: ChangeRequest = {
          ...r,
          status: 'APPROVED',
          decidedBy: op.id,
          decidedAt: now,
        };
        await tx.saveChangeRequest(approved);
        await executor.execute(tx, approved);
        return { request: approved };
      })
      .catch(async (err: unknown) => {
        // A execução recusou: nada foi gravado; registra o STALE numa transação própria.
        const code = ruleCode(err);
        if (code === null || DECISION_ERRORS.has(code)) throw err;
        return this.d.store.transaction(async (tx) =>
          this.stale(
            tx,
            await this.locked(tx, id),
            op,
            this.d.clock.now(),
            (err as Error).message,
            code,
          ),
        );
      });
    this.d.logger.info({
      event: 'change_request.decided',
      requestId: id,
      status: outcome.request.status,
      checker: op.id,
    });
    if (outcome.request.status === 'STALE')
      throw rule('REQUEST_STALE', outcome.request.decisionReason ?? 'Solicitação invalidada.', {
        request: requestView(outcome.request),
      });
    return requestView(outcome.request);
  }

  async reject(op: Operator, id: string, reason: string): Promise<ChangeRequestView> {
    return this.d.store.transaction(async (tx) => {
      const r = await this.locked(tx, id);
      const now = this.d.clock.now();
      assertCanDecide(r, op, now);
      const next: ChangeRequest = {
        ...r,
        status: 'REJECTED',
        decidedBy: op.id,
        decidedAt: now,
        decisionReason: reason,
      };
      await tx.saveChangeRequest(next);
      return requestView(next);
    });
  }

  /** RN-MC-BO-002: só o maker cancela, enquanto pendente. */
  async cancel(op: Operator, id: string): Promise<ChangeRequestView> {
    return this.d.store.transaction(async (tx) => {
      const r = await this.locked(tx, id);
      if (r.makerId !== op.id)
        throw rule('ONLY_MAKER_CAN_CANCEL', 'Só quem propôs cancela a solicitação.');
      if (r.status !== 'PENDING')
        throw rule('REQUEST_NOT_PENDING', `A solicitação está ${r.status}.`);
      const next: ChangeRequest = {
        ...r,
        status: 'CANCELED',
        decidedBy: op.id,
        decidedAt: this.d.clock.now(),
      };
      await tx.saveChangeRequest(next);
      return requestView(next);
    });
  }

  /** Expira as pendentes vencidas (laço de fundo). */
  async expireDue(): Promise<number> {
    return this.d.store.transaction(async (tx) => {
      const now = this.d.clock.now();
      const due = await tx.duePendingRequests(now, 200);
      for (const r of due)
        await tx.saveChangeRequest({
          ...r,
          status: 'EXPIRED',
          decidedAt: now,
          decisionReason: 'Prazo de aprovação vencido.',
        });
      return due.length;
    });
  }

  private async stale(
    tx: ReferenceTx,
    r: ChangeRequest,
    op: Operator,
    now: Instant,
    reason: string,
    code?: string,
  ) {
    const next: ChangeRequest = {
      ...r,
      status: 'STALE',
      decidedBy: op.id,
      decidedAt: now,
      decisionReason: code ? `${code}: ${reason}` : reason,
    };
    await tx.saveChangeRequest(next);
    return { request: next };
  }

  private async locked(tx: ReferenceTx, id: string): Promise<ChangeRequest> {
    const r = await tx.changeRequest(id, { forUpdate: true });
    if (!r) throw notFound('Solicitação inexistente.');
    return r;
  }

  private executor(type: ChangeRequestType): ChangeExecutor {
    const e = this.executors.get(type);
    if (!e) throw new Error(`sem executor para ${type}`);
    return e;
  }
}

/** Erros da decisão em si (não da execução): não invalidam a solicitação. */
const DECISION_ERRORS = new Set([
  'NOT_FOUND',
  'REQUEST_NOT_PENDING',
  'REQUEST_EXPIRED',
  'MAKER_CANNOT_APPROVE',
  'CHECKER_ROLE_REQUIRED',
]);

const ruleCode = (err: unknown): string | null =>
  err instanceof ReferenceRuleError
    ? err.code
    : err instanceof ReferenceError && err.status === 422
      ? err.code
      : null;
