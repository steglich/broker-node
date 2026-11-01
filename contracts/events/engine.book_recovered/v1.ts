import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const EngineBookRecoveredV1 = defineEvent({
  eventType: 'engine.book_recovered',
  eventVersion: 1,
  payload: Type.Object({ instrumentId: Type.String({ format: 'uuid' }) }),
});

export default defineEventContract({
  definition: EngineBookRecoveredV1,
  producer: 'matching-engine',
  consumers: ['trading-session-service'],
  summary: 'Livro recuperado: a sessão retoma o instrumento por leilão (RN-REC-003).',
});
