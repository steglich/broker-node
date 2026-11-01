import { Instant } from '@broker/domain-kernel';
import type { SmmParams } from '../domain/params.js';
import { notFound, rule, SmmError, type SmmDeps } from './context.js';
import { metricsView, type MarketMaker } from './market-maker.js';
import type {
  ChangeRequest,
  ChangeRequestStatus,
  ChangeRequestType,
  InstrumentState,
  SmmTx,
} from './ports.js';

export interface Operator {
  id: string;
  roles: readonly string[];
}

export const requestView = (r: ChangeRequest) => ({
  id: r.id,
  type: r.type,
  payload: r.payload,
  justification: r.justification,
  makerId: r.makerId,
  status: r.status,
  createdAt: r.createdAt.toString(),
  expiresAt: r.expiresAt.toString(),
  decidedBy: r.decidedBy,
  decidedAt: r.decidedAt?.toString() ?? null,
  decisionReason: r.decisionReason,
});

const scopeOf = (instrumentId: string | null) => instrumentId ?? 'GLOBAL';

/**
 * Controles do backoffice (Motor §6.7, Backoffice §3). Desligar é imediato e não pede aprovação;
 * religar e mudar parâmetros passam por dupla aprovação local (`BO_MARKET` propõe, `BO_ADMIN`
 * decide, RN-MC-BO-001..004). Na Fase 3 a decisão vem do approval-service.
 */
export class Backoffice {
  constructor(
    private readonly d: SmmDeps,
    private readonly maker: MarketMaker,
  ) {}

  private assertReason(reason: string): void {
    if (reason.trim().length === 0) throw rule('REASON_REQUIRED', 'O motivo é obrigatório.');
  }

  async state(instrumentId: string) {
    return this.d.store.transaction(async (tx) => {
      const i = await tx.instrument(instrumentId);
      if (!i?.activatedAt) throw notFound('Instrumento sem FMS ativado.');
      const now = this.d.clock.now();
      const control = await tx.control();
      return {
        instrumentId: i.id,
        symbol: i.symbol,
        accountId: this.d.accountId,
        enabled: i.enabled,
        globalEnabled: control.globalEnabled,
        stopped: i.stopped,
        initialStock: i.initialStock,
        reference: i.reference?.toFixed() ?? null,
        spreadMultiplier: i.spreadMultiplier,
        liveOrders: i.liveOrders.map((o) => ({
          orderId: o.orderId,
          board: o.board,
          side: o.side,
          price: o.price,
          remaining: o.remaining,
          status: o.status,
        })),
        parameters: await tx.paramsAt(i.id, now),
        metrics: metricsView(i, now),
      };
    });
  }

  /** RN-SMM-030: desligado, todas as ofertas do escopo são canceladas; repetir não faz nada. */
  disable(op: Operator, input: { instrumentId: string | null; reason: string }) {
    this.assertReason(input.reason);
    return this.d.store.transaction(async (tx) => {
      const c = await tx.lockControl();
      if (input.instrumentId) {
        const i = await this.activated(tx, input.instrumentId);
        if (!i.enabled) return { scope: input.instrumentId, status: 'OFF' as const };
        i.enabled = false;
        await this.maker.requote(tx, i);
      } else {
        if (!c.globalEnabled) return { scope: 'GLOBAL', status: 'OFF' as const };
        c.globalEnabled = false;
        await tx.saveControl(c);
        await this.requoteAll(tx);
      }
      await this.publishStatus(tx, input.instrumentId, 'OFF', input.reason, op.id, null);
      return { scope: scopeOf(input.instrumentId), status: 'OFF' as const };
    });
  }

  private async requoteAll(tx: SmmTx): Promise<void> {
    for (const id of await tx.instrumentIds())
      await this.maker.requote(tx, await tx.lockInstrument(id));
  }

  private async activated(tx: SmmTx, id: string): Promise<InstrumentState> {
    const known = await tx.instrument(id);
    if (!known?.activatedAt) throw notFound('Instrumento sem FMS ativado.');
    return tx.lockInstrument(id);
  }

  private async publishStatus(
    tx: SmmTx,
    instrumentId: string | null,
    status: 'ON' | 'OFF',
    reason: string,
    actorId: string,
    approvalRequestId: string | null,
  ): Promise<void> {
    const scope = scopeOf(instrumentId);
    await tx.publish(
      {
        type: 'smm.status_changed',
        payload: { scope, status, reason, actorId, approvalRequestId },
      },
      scope,
    );
  }

  // ------------------------------------------------------------------- dupla aprovação

  proposeEnable(op: Operator, input: { instrumentId: string | null; justification: string }) {
    this.assertReason(input.justification);
    return this.propose(op, 'SMM_ENABLE', input.justification, {
      instrumentId: input.instrumentId,
    });
  }

  proposeParameters(
    op: Operator,
    input: { instrumentId: string; params: Partial<SmmParams>; justification: string },
  ) {
    this.assertReason(input.justification);
    return this.propose(op, 'SMM_PARAMETERS', input.justification, {
      instrumentId: input.instrumentId,
      params: input.params,
    });
  }

  private propose(
    op: Operator,
    type: ChangeRequestType,
    justification: string,
    payload: Record<string, unknown>,
  ) {
    return this.d.store.transaction(async (tx) => {
      const instrumentId = (payload['instrumentId'] as string | null) ?? null;
      if (instrumentId && !(await tx.instrument(instrumentId))?.activatedAt)
        throw notFound('Instrumento sem FMS ativado.');
      if (type === 'SMM_ENABLE' && (await this.isOn(tx, instrumentId)))
        throw rule('SMM_ALREADY_ON', 'O FMS já está ligado neste escopo.');
      const now = this.d.clock.now();
      const request: ChangeRequest = {
        id: this.d.newId(),
        type,
        payload,
        currentState: await this.currentState(tx, instrumentId),
        justification,
        makerId: op.id,
        status: 'PENDING',
        createdAt: now,
        expiresAt: now.plusMillis(this.d.requestTtlHours * 3_600_000),
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
      };
      await tx.insertChangeRequest(request);
      return requestView(request);
    });
  }

  private async isOn(tx: SmmTx, instrumentId: string | null): Promise<boolean> {
    if (!instrumentId) return (await tx.control()).globalEnabled;
    return (await tx.instrument(instrumentId))?.enabled ?? false;
  }

  /** O que a aprovação compara (RN-MC-BO-003): o estado do kill switch e os parâmetros vigentes. */
  private async currentState(tx: SmmTx, instrumentId: string | null): Promise<string> {
    const on = await this.isOn(tx, instrumentId);
    const params = instrumentId ? await tx.paramsAt(instrumentId, this.d.clock.now()) : null;
    return JSON.stringify({ on, params });
  }

  approve(op: Operator, id: string) {
    return this.d.store.transaction(async (tx) => {
      const c = await tx.lockControl();
      const r = await this.pendingForDecision(tx, op, id);
      const instrumentId = (r.payload['instrumentId'] as string | null) ?? null;
      if ((await this.currentState(tx, instrumentId)) !== r.currentState) {
        this.decide(r, op, 'STALE', 'O estado do FMS mudou desde a proposta.');
        await tx.saveChangeRequest(r);
        return requestView(r);
      }
      if (r.type === 'SMM_ENABLE') {
        if (instrumentId) {
          const i = await tx.lockInstrument(instrumentId);
          i.enabled = true;
          await this.maker.requote(tx, i);
        } else {
          c.globalEnabled = true;
          await tx.saveControl(c);
          await this.requoteAll(tx);
        }
        await this.publishStatus(tx, instrumentId, 'ON', r.justification, r.makerId, r.id);
      } else {
        await tx.insertParams({
          id: this.d.newId(),
          instrumentId,
          params: r.payload['params'] as Partial<SmmParams>,
          validFrom: this.d.clock.now(),
          approvalRequestId: r.id,
        });
        if (instrumentId) await this.maker.requote(tx, await tx.lockInstrument(instrumentId));
      }
      this.decide(r, op, 'APPROVED', null);
      await tx.saveChangeRequest(r);
      return requestView(r);
    });
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
        throw new SmmError(403, 'FORBIDDEN', 'Só quem propôs pode cancelar.');
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
      const now: Instant = this.d.clock.now();
      const due = await tx.duePendingRequests(now, 100);
      for (const r of due) {
        r.status = 'EXPIRED';
        r.decidedAt = now;
        await tx.saveChangeRequest(r);
      }
      return due.length;
    });
  }

  private async pendingForDecision(tx: SmmTx, op: Operator, id: string): Promise<ChangeRequest> {
    const r = await tx.changeRequest(id, { forUpdate: true });
    if (!r) throw notFound('Solicitação inexistente.');
    if (r.status !== 'PENDING')
      throw rule('REQUEST_NOT_PENDING', `A solicitação está ${r.status}.`);
    if (!r.expiresAt.isAfter(this.d.clock.now()))
      throw rule('REQUEST_EXPIRED', 'A solicitação expirou.');
    if (r.makerId === op.id)
      throw new SmmError(403, 'MAKER_CANNOT_DECIDE', 'Quem propôs não decide a solicitação.');
    if (!op.roles.includes('BO_ADMIN'))
      throw new SmmError(403, 'FORBIDDEN', 'Só BO_ADMIN decide esta solicitação.');
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
