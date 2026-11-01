// market-maker-service (catálogo de serviços §10, Contratos §15): estado, parâmetros e kill switch do
// FMS no backoffice.
import Type from 'typebox';
import { defineHttpContract } from '../src/define.js';

const Uuid = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const OptString = Type.Union([Type.String(), Type.Null()]);
const LimitQuery = Type.Object({ limit: Type.Optional(Type.String({ pattern: '^\\d+$' })) });
const IdParam = Type.Object({ id: Uuid });
const InstrumentParam = Type.Object({ instrumentId: Uuid });
const Justification = Type.String({ minLength: 1 });

/** O spread fica de fora: o dono é o reference-data, em `instrument_trading_rules` (Ativos §7). */
const SmmParamsValues = Type.Object({
  levels: Type.Integer({ minimum: 1, maximum: 20 }),
  levelStepBps: Type.Integer({ minimum: 1 }),
  baseQuantityLots: Type.Integer({ minimum: 1 }),
  levelMultiplier: Type.String({ pattern: '^\\d+(\\.\\d{1,4})?$' }),
  inventoryLimitLots: Type.Integer({ minimum: 1 }),
  skewFactor: Type.String({ pattern: '^\\d+(\\.\\d{1,4})?$' }),
  maxSweepLots: Type.Integer({ minimum: 0 }),
  oddLotEnabled: Type.Boolean(),
  requoteThresholdTicks: Type.Integer({ minimum: 0 }),
  refreshIntervalS: Type.Integer({ minimum: 1 }),
});

export const KillSwitchBody = Type.Object({
  /** `false` desliga na hora; `true` abre a solicitação de religar (Backoffice §3). */
  enabled: Type.Boolean(),
  /** Ausente = global. */
  instrumentId: Type.Optional(Uuid),
  justification: Justification,
});

export const ParametersBody = Type.Object({
  params: Type.Partial(SmmParamsValues, { minProperties: 1, additionalProperties: false }),
  justification: Justification,
});

export const RejectBody = Type.Object({ reason: Justification });

const Metrics = Type.Object({
  instrumentId: Uuid,
  inventory: Type.Integer(),
  realizedPnl: Type.String(),
  unrealizedPnl: OptString,
  volume: Type.Integer({ minimum: 0 }),
  requotes: Type.Integer({ minimum: 0 }),
  effectiveSpreadBps: OptString,
  quotedSeconds: Type.Integer({ minimum: 0 }),
  bestBid: OptString,
  bestAsk: OptString,
  at: DateTime,
});

const SmmState = Type.Object({
  instrumentId: Uuid,
  symbol: OptString,
  accountId: Uuid,
  enabled: Type.Boolean(),
  globalEnabled: Type.Boolean(),
  stopped: Type.Boolean(),
  initialStock: Type.Integer({ minimum: 0 }),
  reference: OptString,
  spreadMultiplier: Type.Integer({ minimum: 1 }),
  liveOrders: Type.Array(
    Type.Object({
      orderId: Uuid,
      board: Type.String(),
      side: Type.String(),
      price: Type.String(),
      remaining: Type.Integer({ minimum: 0 }),
      status: Type.String(),
    }),
  ),
  parameters: Type.Record(Type.String(), Type.Unknown()),
  metrics: Metrics,
});

const KillSwitchResult = Type.Object({ scope: Type.String(), status: Type.Literal('OFF') });

const ChangeRequest = Type.Object({
  id: Uuid,
  type: Type.Union([Type.Literal('SMM_ENABLE'), Type.Literal('SMM_PARAMETERS')]),
  payload: Type.Record(Type.String(), Type.Unknown()),
  justification: Type.String(),
  makerId: Type.String(),
  status: Type.String(),
  createdAt: DateTime,
  expiresAt: DateTime,
  decidedBy: OptString,
  decidedAt: Type.Union([DateTime, Type.Null()]),
  decisionReason: OptString,
});

const requestResponse = {
  200: { description: 'Solicitação depois da decisão.', body: ChangeRequest },
  404: { description: 'Solicitação inexistente.' },
  422: { description: 'Solicitação fora de `PENDING` ou expirada.' },
};

export const marketMakerServiceHttp = defineHttpContract({
  service: 'market-maker-service',
  title: 'market-maker-service',
  version: '1.0.0',
  routes: {
    killSwitch: {
      method: 'post',
      path: '/v1/bo/smm/kill-switch',
      summary: 'Desliga o FMS, por instrumento ou global, ou propõe religar (RN-SMM-030).',
      auth: 'user',
      body: KillSwitchBody,
      responses: {
        200: {
          description: 'Desligado; todas as ofertas do escopo canceladas.',
          body: KillSwitchResult,
        },
        202: { description: 'Solicitação de religar aberta.', body: ChangeRequest },
        404: { description: 'Instrumento sem FMS ativado.' },
        422: { description: 'O FMS já está ligado neste escopo.' },
      },
    },
    changeRequests: {
      method: 'get',
      path: '/v1/bo/smm/change-requests',
      summary: 'Solicitações de religar e de parâmetros.',
      auth: 'user',
      query: Type.Object({
        status: Type.Optional(
          Type.Union(
            ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELED', 'STALE'].map((s) =>
              Type.Literal(s),
            ),
          ),
        ),
        limit: LimitQuery.properties.limit,
      }),
      responses: {
        200: { description: 'Lista.', body: Type.Object({ items: Type.Array(ChangeRequest) }) },
      },
    },
    approveRequest: {
      method: 'post',
      path: '/v1/bo/smm/change-requests/:id/approve',
      summary: 'Aprova; `STALE` se o estado mudou desde a proposta (RN-MC-BO-003).',
      auth: 'user',
      params: IdParam,
      responses: requestResponse,
    },
    rejectRequest: {
      method: 'post',
      path: '/v1/bo/smm/change-requests/:id/reject',
      summary: 'Rejeita com motivo.',
      auth: 'user',
      params: IdParam,
      body: RejectBody,
      responses: requestResponse,
    },
    cancelRequest: {
      method: 'post',
      path: '/v1/bo/smm/change-requests/:id/cancel',
      summary: 'Quem propôs desiste.',
      auth: 'user',
      params: IdParam,
      responses: requestResponse,
    },
    state: {
      method: 'get',
      path: '/v1/bo/smm/:instrumentId',
      summary: 'Inventário, P&L, spread efetivo, ofertas e parâmetros (RN-SMM-031).',
      auth: 'user',
      params: InstrumentParam,
      responses: {
        200: { description: 'Estado.', body: SmmState },
        404: { description: 'Instrumento sem FMS ativado.' },
      },
    },
    parameters: {
      method: 'put',
      path: '/v1/bo/smm/:instrumentId',
      summary: 'Propõe nova vigência dos parâmetros `smm_*` (Backoffice §3).',
      auth: 'user',
      params: InstrumentParam,
      body: ParametersBody,
      responses: {
        202: { description: 'Solicitação aberta.', body: ChangeRequest },
        404: { description: 'Instrumento sem FMS ativado.' },
      },
    },
  },
});

export default marketMakerServiceHttp;
