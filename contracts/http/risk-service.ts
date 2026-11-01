// risk-service (Contratos §10): os RPCs internos do pré-trade e dos holds de saque (D11).
import Type from 'typebox';
import { defineHttpContract } from '../src/define.js';
import { Classification, OrderSide, PreTradeFigures, RiskAmount } from '../src/schemas/risk.js';

const Uuid = Type.String({ format: 'uuid' });
const Price = Type.String({ pattern: '^\\d+(\\.\\d{1,8})?$' });

/**
 * `TRIGGER` e `ocoGroupId` (Contratos §10.1) entram com as ordens condicionais e o OCO (Fase 4).
 * Em `REPLACE`, `quantity` é a quantidade em aberto depois da alteração: o que já executou saiu do hold.
 */
export const PreTradeBody = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 128 }),
  accountId: Uuid,
  orderId: Uuid,
  instrumentId: Uuid,
  board: Type.Union([Type.Literal('MAIN'), Type.Literal('ODD_LOT')]),
  side: OrderSide,
  type: Type.Union([Type.Literal('MARKET'), Type.Literal('LIMIT')]),
  quantity: Type.Integer({ minimum: 1 }),
  /** Limite da ordem ou preço de proteção a mercado (RN-HLD-002). */
  referencePrice: Price,
  timeInForce: Type.Union(['DAY', 'GTC', 'GTD', 'IOC', 'FOK'].map((t) => Type.Literal(t))),
  tradeIntent: Type.Union([Type.Literal('NORMAL'), Type.Literal('DAY_TRADE')]),
  operation: Type.Union([Type.Literal('NEW'), Type.Literal('REPLACE')]),
});

const PreTradeResult = Type.Object({
  decision: Type.Union([Type.Literal('APPROVED'), Type.Literal('REJECTED')]),
  holdId: Type.Optional(Uuid),
  classification: Type.Optional(Classification),
  rejectCode: Type.Optional(Type.String()),
  figures: Type.Optional(PreTradeFigures),
});

/**
 * Hold de saque (Contratos §10.2). `requestId` é também o `hold_id`: quem pede o conhece mesmo se a
 * resposta se perder, e consegue liberá-lo. Os tipos `BTC_*` chegam com o aluguel (Fase 5).
 */
export const CreateHoldBody = Type.Object({
  requestId: Uuid,
  holdType: Type.Literal('WITHDRAWAL'),
  accountId: Uuid,
  amount: RiskAmount,
  reference: Type.Object({ type: Type.Literal('WITHDRAWAL'), id: Uuid }),
});

const CreateHoldResult = Type.Object({
  decision: Type.Union([Type.Literal('APPROVED'), Type.Literal('REJECTED')]),
  holdId: Type.Optional(Uuid),
  rejectCode: Type.Optional(Type.String()),
  figures: Type.Optional(PreTradeFigures),
});

export const ReleaseHoldBody = Type.Object({
  outcome: Type.Union([Type.Literal('CONSUMED'), Type.Literal('CANCELED')]),
});

const ReleaseHoldResult = Type.Object({
  holdId: Uuid,
  status: Type.Union([
    Type.Literal('ACTIVE'),
    Type.Literal('CONSUMED'),
    Type.Literal('RELEASED'),
    Type.Literal('UNKNOWN'),
  ]),
});

const unavailable = {
  description: 'Projeção em reconstrução ou instância em espera (fail closed).',
};

export const riskServiceHttp = defineHttpContract({
  service: 'risk-service',
  title: 'risk-service',
  version: '1.0.0',
  routes: {
    preTrade: {
      method: 'post',
      path: '/v1/internal/risk/pre-trade',
      summary: 'Decide a ordem e cria o hold, em série por conta (Risco §11, RN-PTC-001).',
      auth: 'service',
      body: PreTradeBody,
      responses: {
        200: {
          description: 'Decisão; repetir o `requestId` devolve a mesma.',
          body: PreTradeResult,
        },
        503: unavailable,
      },
    },
    createHold: {
      method: 'post',
      path: '/v1/internal/risk/holds',
      summary: 'Reserva o valor do saque sobre o sacável da projeção (RN-LED-030).',
      auth: 'service',
      body: CreateHoldBody,
      responses: {
        200: {
          description: 'Decisão; repetir o `requestId` não reserva duas vezes.',
          body: CreateHoldResult,
        },
        503: unavailable,
      },
    },
    releaseHold: {
      method: 'post',
      path: '/v1/internal/risk/holds/:id/release',
      summary:
        'Consome ou libera o hold; idempotente, e hold desconhecido não é erro (RN-LED-032).',
      auth: 'service',
      params: Type.Object({ id: Uuid }),
      body: ReleaseHoldBody,
      responses: {
        200: { description: 'Estado do hold depois do pedido.', body: ReleaseHoldResult },
        503: unavailable,
      },
    },
  },
});

export default riskServiceHttp;
