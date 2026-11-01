import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { SessionPrice } from '../../src/schemas/session.js';

const Money = Type.String({ pattern: '^-?\\d+(\\.\\d+)?$' });

export const SmmMetricsV1 = defineEvent({
  eventType: 'smm.metrics',
  eventVersion: 1,
  payload: Type.Object({
    instrumentId: Type.String({ format: 'uuid' }),
    /** Ações, relativo ao estoque inicial: positivo é comprado. */
    inventory: Type.Integer(),
    realizedPnl: Money,
    /** Inventário a mercado pela referência; `null` antes da primeira referência. */
    unrealizedPnl: Type.Union([Money, Type.Null()]),
    /** Ações negociadas desde a ativação. */
    volume: Type.Integer({ minimum: 0 }),
    requotes: Type.Integer({ minimum: 0 }),
    /** Em bps, da melhor compra e venda atuais; `null` sem as duas pontas. */
    effectiveSpreadBps: Type.Union([Money, Type.Null()]),
    /** Tempo acumulado com alguma oferta ativa. */
    quotedSeconds: Type.Integer({ minimum: 0 }),
    bestBid: Type.Union([SessionPrice, Type.Null()]),
    bestAsk: Type.Union([SessionPrice, Type.Null()]),
    at: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: SmmMetricsV1,
  producer: 'market-maker-service',
  context: 'market-maker',
  consumers: ['reporting-service'],
  summary: 'Métricas do FMS por instrumento, a cada `smm_refresh_interval` (RN-SMM-031).',
});
