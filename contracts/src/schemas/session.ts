import Type from 'typebox';

/** Esquemas compartilhados pelos eventos e comandos da sessão de negociação (Pregão §4–§7). */

export const SessionPhase = Type.Union(
  [
    'CLOSED',
    'PRE_TRADING',
    'PRE_OPENING',
    'CONTINUOUS',
    'CLOSING_CALL',
    'POST_CLOSE',
    'AFTER_MARKET',
    'VOLATILITY_AUCTION',
    'HALTED',
  ].map((p) => Type.Literal(p)),
);

/** `MARKET` (todo o segmento) ou o `instrument_id` (RN-SES-002). */
export const SessionScope = Type.Union([Type.Literal('MARKET'), Type.String({ format: 'uuid' })]);

export const AuctionType = Type.Union(
  ['OPENING', 'CLOSING', 'VOLATILITY', 'REOPENING'].map((t) => Type.Literal(t)),
);

export const Board = Type.Union([Type.Literal('MAIN'), Type.Literal('ODD_LOT')]);

export const SessionPrice = Type.String({ pattern: '^\\d+(\\.\\d{1,8})?$' });
