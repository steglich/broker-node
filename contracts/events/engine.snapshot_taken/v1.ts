import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const EngineSnapshotTakenV1 = defineEvent({
  eventType: 'engine.snapshot_taken',
  eventVersion: 1,
  payload: Type.Object({
    instrumentId: Type.String({ format: 'uuid' }),
    inputSeq: Type.Integer({ minimum: 0 }),
  }),
});

export default defineEventContract({
  definition: EngineSnapshotTakenV1,
  producer: 'matching-engine',
  summary:
    'Controle interno: snapshot gravado (RN-REC-001). Fica fora de `engine_seq`: tirar snapshot não pode mudar as saídas.',
});
