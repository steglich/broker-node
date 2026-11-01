// trading-session-service (catálogo de serviços §6, Contratos §4 e §15): estado da sessão e controle
// do pregão pelo backoffice.
import Type from 'typebox';
import { defineHttpContract } from '../src/define.js';
import { AuctionType, SessionPhase } from '../src/schemas/session.js';

const Uuid = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const DateOnly = Type.String({ format: 'date' });
const OptDateTime = Type.Union([DateTime, Type.Null()]);
const OptString = Type.Union([Type.String(), Type.Null()]);
const LimitQuery = Type.Object({ limit: Type.Optional(Type.String({ pattern: '^\\d+$' })) });
const IdParam = Type.Object({ id: Uuid });

const AuctionView = Type.Object({
  auctionId: Uuid,
  type: AuctionType,
  status: Type.String(),
  startedAt: DateTime,
  expectedEndAt: DateTime,
  effectiveEndAt: OptDateTime,
  extensions: Type.Integer({ minimum: 0 }),
  theoreticalPrice: OptString,
});

const NextEvent = Type.Object({ phase: SessionPhase, at: DateTime });

const InstrumentSession = Type.Object({
  instrumentId: Uuid,
  symbol: Type.String(),
  /** A fase efetiva (RN-SES-001). */
  phase: SessionPhase,
  reason: OptString,
  since: OptDateTime,
  expectedEndAt: OptDateTime,
  auction: Type.Union([AuctionView, Type.Null()]),
  previousClose: OptString,
  bandReferencePrice: OptString,
});

const MarketSession = Type.Object({
  businessDate: Type.Union([DateOnly, Type.Null()]),
  tradingDayStatus: OptString,
  market: Type.Object({
    phase: SessionPhase,
    scheduledPhase: SessionPhase,
    since: DateTime,
    expectedEndAt: OptDateTime,
    reason: Type.String(),
  }),
  instruments: Type.Array(InstrumentSession),
  nextEvents: Type.Array(NextEvent),
});

const HaltView = Type.Object({
  haltId: Uuid,
  scope: Type.String(),
  reasonCode: Type.String(),
  description: OptString,
  startedAt: DateTime,
  endedAt: OptDateTime,
  resumeAt: OptDateTime,
  cancelAllOnHalt: Type.Boolean(),
  actorId: Type.String(),
  approvalRequestId: Type.Union([Uuid, Type.Null()]),
});

const RequestView = Type.Object({
  id: Uuid,
  type: Type.Union(['MARKET_HALT', 'MARKET_RESUME', 'CIRCUIT_BREAKER'].map((t) => Type.Literal(t))),
  payload: Type.Record(Type.String(), Type.Unknown()),
  currentState: Type.Record(Type.String(), Type.Unknown()),
  justification: Type.String(),
  makerId: Type.String(),
  status: Type.String(),
  createdAt: DateTime,
  expiresAt: DateTime,
  decidedBy: OptString,
  decidedAt: OptDateTime,
  decisionReason: OptString,
});

const Reason = Type.String({ minLength: 1, maxLength: 500 });

export const HaltBody = Type.Object(
  {
    /** Sem `instrumentId`: o mercado inteiro, por dupla aprovação (Backoffice §3). */
    instrumentId: Type.Optional(Uuid),
    reason: Reason,
    cancelAllOnHalt: Type.Optional(Type.Boolean()),
    resumeAt: Type.Optional(DateTime),
  },
  { additionalProperties: false },
);
export const ResumeBody = Type.Object(
  { haltId: Uuid, justification: Type.Optional(Reason) },
  { additionalProperties: false },
);
export const JustificationBody = Type.Object(
  { justification: Reason },
  { additionalProperties: false },
);
export const RejectBody = Type.Object({ reason: Reason }, { additionalProperties: false });

export const tradingSessionServiceHttp = defineHttpContract({
  service: 'trading-session-service',
  title: 'trading-session-service',
  version: '1.0.0',
  routes: {
    session: {
      method: 'get',
      path: '/v1/market/session',
      summary: 'Fase do mercado e de cada instrumento e próximos eventos.',
      auth: 'user',
      responses: { 200: { description: 'Estado da sessão.', body: MarketSession } },
    },
    instrumentSession: {
      method: 'get',
      path: '/v1/market/session/:symbol',
      summary: 'Fase efetiva de um instrumento, leilão em curso e próximos eventos.',
      auth: 'user',
      params: Type.Object({ symbol: Type.String({ pattern: '^[A-Z0-9]{4,8}$' }) }),
      responses: {
        200: {
          description: 'Estado do instrumento.',
          body: Type.Object({ ...InstrumentSession.properties, nextEvents: Type.Array(NextEvent) }),
        },
        404: { description: 'Instrumento inexistente.' },
      },
    },
    halt: {
      method: 'post',
      path: '/v1/bo/session/halt',
      summary: 'Suspende um instrumento (imediato) ou propõe suspender o mercado (aprovação).',
      auth: 'user',
      body: HaltBody,
      responses: {
        200: { description: 'Instrumento suspenso.', body: HaltView },
        202: { description: 'Solicitação criada.', body: RequestView },
      },
    },
    resume: {
      method: 'post',
      path: '/v1/bo/session/resume',
      summary:
        'Retoma um instrumento (imediato) ou propõe retomar o mercado; a volta é por leilão.',
      auth: 'user',
      body: ResumeBody,
      responses: {
        200: { description: 'Instrumento em retomada.', body: HaltView },
        202: { description: 'Solicitação criada.', body: RequestView },
      },
    },
    circuitBreaker: {
      method: 'post',
      path: '/v1/bo/session/circuit-breaker',
      summary: 'Propõe o disparo manual do próximo nível (RN-CB-003).',
      auth: 'user',
      body: JustificationBody,
      responses: { 202: { description: 'Solicitação criada.', body: RequestView } },
    },
    sandboxCircuitBreaker: {
      method: 'post',
      path: '/v1/sandbox/session/circuit-breaker',
      summary: 'Dispara o próximo nível sem aprovação; só com os comandos de sandbox (RN-SBX-005).',
      auth: 'user',
      responses: {
        200: {
          description: 'Disparado.',
          body: Type.Object({ level: Type.Integer({ minimum: 1, maximum: 3 }) }),
        },
      },
    },
    concludeAuction: {
      method: 'post',
      path: '/v1/bo/session/auctions/:id/conclude',
      summary: 'Conclui um leilão mantido, limitado ao túnel (RN-AUC-003).',
      auth: 'user',
      params: IdParam,
      responses: {
        200: {
          description: 'Encerramento enviado ao Motor.',
          body: Type.Object({ auctionId: Uuid, status: Type.String() }),
        },
      },
    },
    halts: {
      method: 'get',
      path: '/v1/bo/session/halts',
      summary: 'Suspensões, da mais recente.',
      auth: 'user',
      query: Type.Object({
        active: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])),
        limit: Type.Optional(Type.String({ pattern: '^\\d+$' })),
      }),
      responses: {
        200: { description: 'Lista.', body: Type.Object({ items: Type.Array(HaltView) }) },
      },
    },
    alerts: {
      method: 'get',
      path: '/v1/bo/session/alerts',
      summary: 'Alertas ao backoffice: prorrogações esgotadas e divergência de fechamento.',
      auth: 'user',
      query: LimitQuery,
      responses: {
        200: {
          description: 'Lista.',
          body: Type.Object({
            items: Type.Array(
              Type.Object({
                id: Uuid,
                kind: Type.String(),
                message: Type.String(),
                data: Type.Record(Type.String(), Type.Unknown()),
                createdAt: DateTime,
              }),
            ),
          }),
        },
      },
    },
    closingPrices: {
      method: 'get',
      path: '/v1/bo/session/closing-prices',
      summary: 'Fechamentos do dia com a origem e o externo (RN-FCH-001/003).',
      auth: 'user',
      query: Type.Object({ date: DateOnly }),
      responses: {
        200: {
          description: 'Lista.',
          body: Type.Object({
            items: Type.Array(
              Type.Object({
                instrumentId: Uuid,
                businessDate: DateOnly,
                price: Type.String(),
                source: Type.String(),
                externalClose: OptString,
                divergenceAlert: Type.Boolean(),
              }),
            ),
          }),
        },
      },
    },
    changeRequests: {
      method: 'get',
      path: '/v1/bo/session/change-requests',
      summary: 'Solicitações de dupla aprovação.',
      auth: 'user',
      query: Type.Object({
        status: Type.Optional(Type.String()),
        limit: Type.Optional(Type.String({ pattern: '^\\d+$' })),
      }),
      responses: {
        200: { description: 'Lista.', body: Type.Object({ items: Type.Array(RequestView) }) },
      },
    },
    approveRequest: {
      method: 'post',
      path: '/v1/bo/session/change-requests/:id/approve',
      summary: 'Aprova e executa (RN-MC-BO-002..004).',
      auth: 'user',
      params: IdParam,
      responses: { 200: { description: 'Decidida.', body: RequestView } },
    },
    rejectRequest: {
      method: 'post',
      path: '/v1/bo/session/change-requests/:id/reject',
      summary: 'Reprova.',
      auth: 'user',
      params: IdParam,
      body: RejectBody,
      responses: { 200: { description: 'Decidida.', body: RequestView } },
    },
    cancelRequest: {
      method: 'post',
      path: '/v1/bo/session/change-requests/:id/cancel',
      summary: 'Cancela (pelo maker).',
      auth: 'user',
      params: IdParam,
      responses: { 200: { description: 'Cancelada.', body: RequestView } },
    },
  },
});

export default tradingSessionServiceHttp;
