import { Money, TaxId } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import { defineBuilder } from './builder.js';
import { DEFAULT_TEST_INSTANT } from './clock.js';
import { generateCpf, type KycScenarioDigit } from './cpf.js';

// Builders dos tipos compartilhados da Fase 0. Os builders de agregado de cada serviço (ordem,
// conta, lançamento…) nascem junto com o serviço, em `<svc>/test/builders.ts`, sobre `defineBuilder`.

export const aMoney = (amount = '100.00') => Money.of(amount, 'BRL');

/** CPF válido; com `penultimateDigit` escolhe o cenário do simulador de KYC (RN-QA-021). */
export const aTaxId = (penultimateDigit?: KycScenarioDigit) =>
  TaxId.parse(generateCpf(penultimateDigit === undefined ? {} : { penultimateDigit }));

export interface TestActor {
  type: 'USER' | 'SERVICE' | 'SYSTEM' | 'BACKOFFICE';
  id: string;
}

export const anActor = defineBuilder<TestActor>(({ seq }) => ({ type: 'USER', id: `user-${seq}` }));

/** Mesmo formato do envelope de `@broker/messaging` (RN-MSG-B §4), sem depender do pacote. */
export interface TestEnvelope {
  eventId: string;
  eventType: string;
  eventVersion: number;
  source: string;
  environment: string;
  occurredAt: string;
  publishedAt?: string;
  partitionKey: string;
  correlationId: string;
  causationId?: string;
  actor: TestActor;
  traceparent?: string;
  auditable: boolean;
  payload: Record<string, unknown>;
}

/** Envelope válido para testar consumidores (o `eventId` é um UUID v7 real). */
export const anEnvelope = defineBuilder<TestEnvelope>(({ seq }) => ({
  eventId: uuidv7(),
  eventType: 'example.pinged',
  eventVersion: 1,
  source: 'test',
  environment: 'test',
  occurredAt: DEFAULT_TEST_INSTANT,
  partitionKey: `key-${seq}`,
  correlationId: `corr-${seq}`,
  actor: { type: 'SYSTEM', id: 'test' },
  auditable: false,
  payload: {},
}));
