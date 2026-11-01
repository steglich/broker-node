import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

export const SmmStatusChangedV1 = defineEvent({
  eventType: 'smm.status_changed',
  eventVersion: 1,
  auditable: true,
  payload: Type.Object({
    /** `GLOBAL` ou o `instrument_id`. */
    scope: Type.Union([Type.Literal('GLOBAL'), Type.String({ format: 'uuid' })]),
    /** `STOPPED`: ligado, mas sem cotar por referência defasada (RN-SMM-032). */
    status: Type.Union(['ON', 'OFF', 'STOPPED'].map((s) => Type.Literal(s))),
    reason: Type.String({ minLength: 1 }),
    actorId: Type.String({ minLength: 1 }),
    /** Só ao religar, que exige aprovação (Backoffice §3). */
    approvalRequestId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  }),
});

export default defineEventContract({
  definition: SmmStatusChangedV1,
  producer: 'market-maker-service',
  context: 'market-maker',
  consumers: ['audit-service'],
  summary: 'O FMS foi ligado, desligado (kill switch) ou parou de cotar (RN-SMM-030/032).',
});
