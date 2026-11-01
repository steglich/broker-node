import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Id = Type.String({ format: 'uuid' });

export const EngineNotesCutoffV1 = defineEvent({
  eventType: 'engine.notes_cutoff',
  eventVersion: 1,
  payload: Type.Object({
    instrumentId: Id,
    tradingDate: Type.String({ format: 'date' }),
  }),
});

export default defineEventContract({
  definition: EngineNotesCutoffV1,
  producer: 'matching-engine',
  context: 'engine',
  kind: 'commands',
  consumers: ['matching-engine'],
  summary:
    'Corte do trade bust: as notas do dia começaram a ser geradas (RN-BST-001). O próprio Motor o coloca no tópico de comandos ao ver a rotina `brokerage_notes`, para ele ser sequenciado com os demais.',
});
