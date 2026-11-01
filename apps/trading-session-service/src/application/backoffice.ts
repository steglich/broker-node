import { Instant } from '@broker/domain-kernel';
import { nextCircuitBreakerLevel, type CircuitBreakerLevel } from '../domain/circuit-breaker.js';
import { AUTO_RESUMED_ONLY, HaltReason } from '../domain/halts.js';
import { notFound, rule, SessionError, type SessionDeps } from './context.js';
import type {
  ChangeRequest,
  ChangeRequestStatus,
  ChangeRequestType,
  Halt,
  SessionTx,
} from './ports.js';
import type { Session } from './session.js';

export interface Operator {
  id: string;
  roles: readonly string[];
}

export interface RequestView extends Omit<ChangeRequest, 'createdAt' | 'expiresAt' | 'decidedAt'> {
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

export const requestView = (r: ChangeRequest): RequestView => ({
  ...r,
  createdAt: r.createdAt.toString(),
  expiresAt: r.expiresAt.toString(),
  decidedAt: r.decidedAt?.toString() ?? null,
});

export const haltView = (h: Halt) => ({
  haltId: h.id,
  scope: h.scope,
  reasonCode: h.reasonCode,
  description: h.description,
  startedAt: h.startedAt.toString(),
  endedAt: h.endedAt?.toString() ?? null,
  resumeAt: h.resumeAt?.toString() ?? null,
  cancelAllOnHalt: h.cancelAllOnHalt,
  actorId: h.actorId,
  approvalRequestId: h.approvalRequestId,
});

/**
 * Ações do backoffice sobre o pregão (Backoffice §3). Suspender e retomar instrumento têm efeito
 * imediato; mercado e circuit breaker passam por dupla aprovação local (`BO_MARKET` propõe,
 * `BO_ADMIN` decide, RN-MC-BO-001..004). Na Fase 3 a decisão vem do approval-service.
 */
export class Backoffice {
  constructor(
    private readonly d: SessionDeps,
    private readonly session: Session,
  ) {}

  private assertReason(reason: string): void {
    if (reason.trim().length === 0) throw rule('REASON_REQUIRED', 'O motivo é obrigatório.');
  }

  haltInstrument(
    op: Operator,
    input: {
      instrumentId: string;
      reason: string;
      cancelAllOnHalt: boolean;
      resumeAt: Instant | null;
    },
  ) {
    this.assertReason(input.reason);
    return this.d.store.transaction(async (tx) => {
      const m = await tx.lockMarket();
      if (!(await tx.instrument(input.instrumentId))) throw notFound('Instrumento inexistente.');
      const halt = await this.session.startHalt(tx, m, {
        scope: input.instrumentId,
        reasonCode: HaltReason.BACKOFFICE,
        description: input.reason,
        resumeAt: input.resumeAt,
        cancelAllOnHalt: input.cancelAllOnHalt,
        actorId: op.id,
      });
      return haltView(halt!);
    });
  }

  resumeInstrument(haltId: string) {
    return this.d.store.transaction(async (tx) => {
      const m = await tx.lockMarket();
      const halt = await this.resumableHalt(tx, haltId);
      if (halt.scope === 'MARKET')
        throw rule('MARKET_RESUME_REQUIRES_APPROVAL', 'Retomar o mercado exige aprovação.');
      await this.session.endHalt(tx, m, halt);
      return haltView(halt);
    });
  }

  private async resumableHalt(tx: SessionTx, haltId: string): Promise<Halt> {
    const halt = await tx.halt(haltId);
    if (!halt) throw notFound('Suspensão inexistente.');
    if (halt.endedAt) throw rule('HALT_ALREADY_ENDED', 'A suspensão já terminou.');
    if (AUTO_RESUMED_ONLY.has(halt.reasonCode))
      throw rule(
        'HALT_NOT_RESUMABLE',
        'Esta suspensão termina quando a causa acaba, não por comando.',
        { reasonCode: halt.reasonCode },
      );
    return halt;
  }

  concludeAuction(auctionId: string) {
    return this.d.store.transaction(async (tx) => {
      const auction = await this.session.concludeAuctionById(tx, auctionId);
      if (!auction) throw rule('AUCTION_NOT_OPEN', 'Leilão inexistente ou já encerrado.');
      return { auctionId: auction.id, status: auction.status };
    });
  }

  // ------------------------------------------------------------------- dupla aprovação

  proposeMarketHalt(
    op: Operator,
    input: { reason: string; cancelAllOnHalt: boolean; resumeAt: Instant | null },
  ) {
    this.assertReason(input.reason);
    return this.propose(op, 'MARKET_HALT', input.reason, {
      reason: input.reason,
      cancelAllOnHalt: input.cancelAllOnHalt,
      resumeAt: input.resumeAt?.toString() ?? null,
    });
  }

  proposeMarketResume(op: Operator, input: { haltId: string; justification: string }) {
    this.assertReason(input.justification);
    return this.propose(op, 'MARKET_RESUME', input.justification, { haltId: input.haltId });
  }

  proposeCircuitBreaker(op: Operator, justification: string) {
    this.assertReason(justification);
    return this.propose(op, 'CIRCUIT_BREAKER', justification, {});
  }

  /** RN-CB-003 / RN-SBX-005: comando de teste, só no sandbox e sem aprovação. */
  sandboxCircuitBreaker() {
    return this.d.store.transaction(async (tx) => {
      const m = await tx.lockMarket();
      const level = await this.nextLevel(tx, m);
      await this.session.triggerCircuitBreaker(tx, m, level, 'SANDBOX', null);
      return { level };
    });
  }

  private async nextLevel(
    tx: SessionTx,
    m: Awaited<ReturnType<SessionTx['lockMarket']>>,
  ): Promise<CircuitBreakerLevel> {
    if (!this.session.continuousTrading(m))
      throw rule(
        'CIRCUIT_BREAKER_NOT_ALLOWED',
        'O circuit breaker só dispara com o mercado em negociação contínua.',
        { phase: m.phase },
      );
    const date = m.businessDate ?? this.d.clock.now().businessDate();
    const level = nextCircuitBreakerLevel(
      (await tx.circuitBreakerEvents(date)).map((e) => e.level),
    );
    if (level === null)
      throw rule('CIRCUIT_BREAKER_EXHAUSTED', 'Os três níveis já dispararam neste pregão.');
    return level;
  }

  private propose(
    op: Operator,
    type: ChangeRequestType,
    justification: string,
    payload: Record<string, unknown>,
  ) {
    return this.d.store.transaction(async (tx) => {
      const m = await tx.lockMarket();
      if (type === 'MARKET_RESUME') {
        const halt = await this.resumableHalt(tx, String(payload['haltId']));
        if (halt.scope !== 'MARKET')
          throw rule('NOT_A_MARKET_HALT', 'A suspensão é de instrumento.');
      }
      if (type === 'CIRCUIT_BREAKER') await this.nextLevel(tx, m);
      const now = this.d.clock.now();
      const request: ChangeRequest = {
        id: this.d.newId(),
        type,
        payload,
        currentState: await this.currentState(tx),
        justification,
        makerId: op.id,
        status: 'PENDING',
        createdAt: now,
        expiresAt: now.plusMillis(this.d.params.requestTtlHours * 3_600_000),
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
      };
      await tx.insertChangeRequest(request);
      return requestView(request);
    });
  }

  /** O que a aprovação compara (RN-MC-BO-003): a suspensão de mercado e os níveis do dia. */
  private async currentState(tx: SessionTx): Promise<Record<string, unknown>> {
    const m = await tx.market();
    const date = m.businessDate ?? this.d.clock.now().businessDate();
    return {
      marketHalts: (await tx.activeHalts('MARKET')).map((h) => h.id).sort(),
      circuitBreakers: (await tx.circuitBreakerEvents(date)).map((e) => e.level).sort(),
    };
  }

  approve(op: Operator, id: string) {
    return this.d.store.transaction(async (tx) => {
      const m = await tx.lockMarket();
      const r = await this.pendingForDecision(tx, op, id);
      const state = await this.currentState(tx);
      if (JSON.stringify(state) !== JSON.stringify(r.currentState)) {
        this.decide(r, op, 'STALE', 'O estado do mercado mudou desde a proposta.');
        await tx.saveChangeRequest(r);
        return requestView(r);
      }
      try {
        await this.execute(tx, m, r);
        this.decide(r, op, 'APPROVED', null);
      } catch (err) {
        if (!(err instanceof SessionError) || err.status !== 422) throw err;
        this.decide(r, op, 'STALE', err.message);
      }
      await tx.saveChangeRequest(r);
      return requestView(r);
    });
  }

  private async execute(
    tx: SessionTx,
    m: Awaited<ReturnType<SessionTx['lockMarket']>>,
    r: ChangeRequest,
  ): Promise<void> {
    if (r.type === 'MARKET_HALT') {
      const resumeAt = r.payload['resumeAt'] as string | null;
      await this.session.startHalt(tx, m, {
        scope: 'MARKET',
        reasonCode: HaltReason.BACKOFFICE,
        description: String(r.payload['reason']),
        resumeAt: resumeAt ? Instant.parse(resumeAt) : null,
        cancelAllOnHalt: r.payload['cancelAllOnHalt'] === true,
        actorId: r.makerId,
        approvalRequestId: r.id,
      });
    } else if (r.type === 'MARKET_RESUME') {
      const halt = await this.resumableHalt(tx, String(r.payload['haltId']));
      await this.session.endHalt(tx, m, halt);
    } else {
      const level = await this.nextLevel(tx, m);
      await this.session.triggerCircuitBreaker(tx, m, level, 'BACKOFFICE', null, {
        actorId: r.makerId,
        approvalRequestId: r.id,
      });
    }
  }

  reject(op: Operator, id: string, reason: string) {
    return this.d.store.transaction(async (tx) => {
      const r = await this.pendingForDecision(tx, op, id);
      this.decide(r, op, 'REJECTED', reason);
      await tx.saveChangeRequest(r);
      return requestView(r);
    });
  }

  cancel(op: Operator, id: string) {
    return this.d.store.transaction(async (tx) => {
      const r = await tx.changeRequest(id, { forUpdate: true });
      if (!r) throw notFound('Solicitação inexistente.');
      if (r.status !== 'PENDING')
        throw rule('REQUEST_NOT_PENDING', `A solicitação está ${r.status}.`);
      if (r.makerId !== op.id)
        throw new SessionError(403, 'FORBIDDEN', 'Só quem propôs pode cancelar.');
      this.decide(r, op, 'CANCELED', null);
      await tx.saveChangeRequest(r);
      return requestView(r);
    });
  }

  async list(status: ChangeRequestStatus | undefined, limit: number) {
    const items = await this.d.store.transaction((tx) => tx.changeRequests(status, limit));
    return { items: items.map(requestView) };
  }

  async expireDue(): Promise<number> {
    return this.d.store.transaction(async (tx) => {
      const now = this.d.clock.now();
      const due = await tx.duePendingRequests(now, 100);
      for (const r of due) {
        r.status = 'EXPIRED';
        r.decidedAt = now;
        await tx.saveChangeRequest(r);
      }
      return due.length;
    });
  }

  private async pendingForDecision(
    tx: SessionTx,
    op: Operator,
    id: string,
  ): Promise<ChangeRequest> {
    const r = await tx.changeRequest(id, { forUpdate: true });
    if (!r) throw notFound('Solicitação inexistente.');
    if (r.status !== 'PENDING')
      throw rule('REQUEST_NOT_PENDING', `A solicitação está ${r.status}.`);
    if (!r.expiresAt.isAfter(this.d.clock.now()))
      throw rule('REQUEST_EXPIRED', 'A solicitação expirou.');
    if (r.makerId === op.id)
      throw new SessionError(403, 'MAKER_CANNOT_DECIDE', 'Quem propôs não decide a solicitação.');
    if (!op.roles.includes('BO_ADMIN'))
      throw new SessionError(403, 'FORBIDDEN', 'Só BO_ADMIN decide esta solicitação.');
    return r;
  }

  private decide(
    r: ChangeRequest,
    op: Operator,
    status: ChangeRequestStatus,
    reason: string | null,
  ): void {
    r.status = status;
    r.decidedBy = op.id;
    r.decidedAt = this.d.clock.now();
    r.decisionReason = reason;
  }
}
