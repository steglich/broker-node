import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Uuid = Type.String({ format: 'uuid' });
const Profile = Type.Union([
  Type.Literal('CONSERVATIVE'),
  Type.Literal('MODERATE'),
  Type.Literal('AGGRESSIVE'),
]);

export const SuitabilityAssessedV1 = defineEvent({
  eventType: 'suitability.assessed',
  eventVersion: 1,
  payload: Type.Object({
    customerId: Uuid,
    accountId: Type.Optional(Uuid),
    profile: Profile,
    score: Type.Integer({ minimum: 0 }),
    validUntil: Type.String({ format: 'date' }),
    questionnaireVersion: Type.Integer({ minimum: 1 }),
  }),
});

export default defineEventContract({
  definition: SuitabilityAssessedV1,
  producer: 'customer-service',
  context: 'customer',
  consumers: ['risk-service', 'oms-service'],
  summary: 'Novo perfil de investidor (RN-SUI-003).',
});
