import { ReferenceRuleError } from '../domain/errors.js';
import { assertCanInclude, assertCanRemove } from '../domain/universe.js';
import type { ChangeExecutor, ChangeRequests, ChangeRequestView } from './change-requests.js';
import { requestView } from './change-requests.js';
import { notFound, type Operator, type ReferenceDeps } from './context.js';
import { instrumentState, view, type Instruments } from './instruments.js';
import type { ReferenceTx } from './ports.js';
import type { ChangeRequest } from '../domain/change-request.js';

/**
 * Universo negociável (Ativos §4, RN-INS-011..014): incluir e retirar exigem dupla aprovação
 * (`BO_MARKET` propõe, `BO_ADMIN` aprova). O limite e as ordens abertas são conferidos ao propor
 * e de novo ao executar, porque o universo pode ter mudado no meio.
 */
export class Universe implements ChangeExecutor {
  constructor(
    private readonly d: ReferenceDeps,
    private readonly instruments: Instruments,
    private readonly requests: ChangeRequests,
  ) {
    requests.register(['UNIVERSE_INCLUDE', 'UNIVERSE_REMOVE'], this);
  }

  async snapshot() {
    return this.d.store.transaction(async (tx) => {
      const items = await tx.instruments({ tradable: true, limit: 500 });
      return { max: this.d.maxTradableInstruments, count: items.length, items: items.map(view) };
    });
  }

  async request(
    op: Operator,
    input: { instrumentId: string; action: 'INCLUDE' | 'REMOVE'; justification: string },
  ): Promise<ChangeRequestView> {
    return this.d.store.transaction(async (tx) => {
      const i = await tx.instrument(input.instrumentId);
      if (!i) throw notFound('Instrumento inexistente.');
      if (input.action === 'INCLUDE')
        assertCanInclude(i, await tx.tradableCount(), this.d.maxTradableInstruments);
      else assertCanRemove(i, await this.d.openOrders.openOrdersCount(i.id));
      const r = await this.requests.create(tx, op, {
        type: input.action === 'INCLUDE' ? 'UNIVERSE_INCLUDE' : 'UNIVERSE_REMOVE',
        targetId: i.id,
        payload: { instrumentId: i.id, symbol: i.symbol },
        justification: input.justification,
      });
      return requestView(r);
    });
  }

  async currentState(tx: ReferenceTx, r: Pick<ChangeRequest, 'targetId'>) {
    const i = await tx.instrument(r.targetId);
    return {
      tradable: i?.tradable ?? null,
      status: i?.status ?? null,
      lotSize: i?.lotSize ?? null,
    };
  }

  /**
   * Inclusão: `tradable = true`, `PENDING` até a primeira cotação e `instrument.tradability_changed`,
   * que dispara histórico, cotação, livros e FMS (RN-INS-014). Retirada: `tradable = false`; as
   * posições seguem em custódia (RN-INS-013).
   */
  async execute(tx: ReferenceTx, r: ChangeRequest): Promise<void> {
    await tx.lockUniverse();
    const i = await tx.instrument(r.targetId, { forUpdate: true });
    if (!i) throw new ReferenceRuleError('INSTRUMENT_NOT_FOUND', 'Instrumento inexistente.');
    const include = r.type === 'UNIVERSE_INCLUDE';
    if (include) assertCanInclude(i, await tx.tradableCount(), this.d.maxTradableInstruments);
    else assertCanRemove(i, await this.d.openOrders.openOrdersCount(i.id));
    let next = { ...i, tradable: include, updatedAt: this.d.clock.now() };
    await tx.saveInstrument(next);
    if (include && next.status !== 'PENDING')
      next = await this.instruments.transition(tx, next, 'PENDING', 'AWAITING_FIRST_QUOTE');
    else await tx.publish({ type: 'instrument.updated', payload: instrumentState(next) }, i.id);
    const state = instrumentState(next);
    await tx.publish(
      {
        type: 'instrument.tradability_changed',
        payload: {
          instrumentId: i.id,
          symbol: i.symbol,
          oddLotSymbol: state.oddLotSymbol,
          lotSize: i.lotSize,
          tradable: include,
          approvalRequestId: r.id,
        },
      },
      i.id,
    );
  }
}
