import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const EngineBookRecoveringV1 = defineEvent({
  eventType: 'engine.book_recovering',
  eventVersion: 1,
  payload: Type.Object({ instrumentId: Type.String({ format: 'uuid' }) }),
});

export default defineEventContract({
  definition: EngineBookRecoveringV1,
  producer: 'matching-engine',
  consumers: ['trading-session-service'],
  summary: 'Livro em recuperação: o instrumento fica `HALTED` com `ENGINE_RECOVERY` (RN-REC-003).',
});
