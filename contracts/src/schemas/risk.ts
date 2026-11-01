import Type from 'typebox';

const Uuid = Type.String({ format: 'uuid' });

/** Dinheiro com 2 casas; sem sinal (reservas) ou com sinal (poder de compra). */
export const RiskAmount = Type.String({ pattern: '^\\d+\\.\\d{2}$' });
export const RiskSignedAmount = Type.String({ pattern: '^-?\\d+\\.\\d{2}$' });

export const HoldType = Type.Union(
  ['ORDER_CASH', 'ORDER_POSITION', 'ORDER_MARGIN', 'WITHDRAWAL', 'BTC_COLLATERAL', 'BTC_LENT'].map(
    (t) => Type.Literal(t),
  ),
);

/**
 * Payload dos eventos do ciclo de um hold (Catálogo §8, RN-HLD-001): `amount` e `quantity` são o que
 * ainda resta reservado depois do evento. `resource` é `CASH` ou o `instrument_id`.
 */
export const HoldEventPayload = Type.Object({
  holdId: Uuid,
  accountId: Uuid,
  type: HoldType,
  resource: Type.String({ minLength: 1 }),
  amount: RiskAmount,
  quantity: Type.Optional(Type.Integer({ minimum: 0 })),
  reference: Type.Object({
    type: Type.String({ minLength: 1 }),
    id: Type.String({ minLength: 1 }),
  }),
});

export const OrderSide = Type.Union([Type.Literal('BUY'), Type.Literal('SELL')]);

/** Valores usados na decisão (Contratos §10.1, RN-PTC-002): a UI explica a recusa com eles. */
export const PreTradeFigures = Type.Object({
  required: Type.String(),
  available: Type.String(),
  buyingPower: Type.Optional(RiskSignedAmount),
});

export const Classification = Type.Union(
  ['COVERED_BUY', 'COVERED_SELL', 'SHORT_SALE'].map((c) => Type.Literal(c)),
);
