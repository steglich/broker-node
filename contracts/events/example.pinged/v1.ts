import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const ExamplePingedV1 = defineEvent({
  eventType: 'example.pinged',
  eventVersion: 1,
  payload: Type.Object({ pingId: Type.String({ format: 'uuid' }) }),
});

export default defineEventContract({
  definition: ExamplePingedV1,
  producer: 'example-service',
  consumers: ['example-service'],
  summary: 'Um ping foi registrado e aguarda processamento.',
});
