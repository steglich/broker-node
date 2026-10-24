import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const ClockTickedV1 = defineEvent({
  eventType: 'clock.ticked',
  eventVersion: 1,
  payload: Type.Object({
    /** O tempo do ambiente a partir de agora (RN-CLK-003). */
    virtualNow: Type.String({ format: 'date-time' }),
    mode: Type.Union([Type.Literal('ACCELERATED'), Type.Literal('VIRTUAL')]),
    /** Quantas vezes mais rápido que o tempo real (1 em VIRTUAL, onde o tempo só anda por comando). */
    speedFactor: Type.Number({ exclusiveMinimum: 0 }),
  }),
});

export default defineEventContract({
  definition: ClockTickedV1,
  producer: 'scheduler-service',
  context: 'scheduler',
  consumers: ['all-services'],
  summary:
    'Tempo do ambiente em ACCELERATED (a cada minuto virtual) e VIRTUAL (a cada advance_to).',
});
