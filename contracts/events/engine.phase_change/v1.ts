import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { AuctionType, SessionPhase, SessionPrice } from '../../src/schemas/session.js';

export const EnginePhaseChangeV1 = defineEvent({
  eventType: 'engine.phase_change',
  eventVersion: 1,
  payload: Type.Object({
    /** Sempre um instrumento: a chave de `engine.commands` é o `instrument_id`, então uma mudança de mercado vira um comando por instrumento. */
    scope: Type.String({ format: 'uuid' }),
    phase: SessionPhase,
    auctionId: Type.Optional(Type.String({ format: 'uuid' })),
    auctionType: Type.Optional(AuctionType),
    /** Fim previsto do leilão que a fase abre ou prorroga. */
    auctionEndAt: Type.Optional(Type.String({ format: 'date-time' })),
    /** Semente do encerramento aleatório (RN-AUC-033), estável por leilão. */
    randomSeed: Type.Optional(Type.String()),
    /** Leilão aberto que este comando encerra: o Motor conclui dentro da janela aleatória. */
    concludesAuctionId: Type.Optional(Type.String({ format: 'uuid' })),
    /** Preço teórico limitado ao túnel, na política de conclusão (RN-AUC-003). */
    priceLimit: Type.Optional(
      Type.Object({ min: SessionPrice, max: SessionPrice }, { additionalProperties: false }),
    ),
  }),
});

export default defineEventContract({
  definition: EnginePhaseChangeV1,
  producer: 'trading-session-service',
  context: 'engine',
  kind: 'commands',
  consumers: ['matching-engine'],
  summary:
    'Comando `PhaseChange`: fase efetiva de um instrumento no Motor (RN-SES-002, Catálogo §6).',
});
