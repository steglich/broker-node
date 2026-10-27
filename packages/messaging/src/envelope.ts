import Type, { type Static } from 'typebox';
import { InvalidMessageError } from './errors.js';
import { validationErrors } from './validation.js';

/** Ambientes isolados (RN-PAD-080). O consumidor recusa mensagens de outro ambiente. */
export type Environment = string;

const Actor = Type.Object({
  type: Type.Union([
    Type.Literal('USER'),
    Type.Literal('SERVICE'),
    Type.Literal('SYSTEM'),
    Type.Literal('BACKOFFICE'),
  ]),
  id: Type.String({ minLength: 1 }),
});

/**
 * Envelope padrão de toda mensagem (RN-MSG-B §4), inspirado em CloudEvents sem depender dele.
 * Campos extras são aceitos e ignorados (tolerant reader, RN-MSG-B-022).
 */
export const EnvelopeSchema = Type.Object({
  /** UUID v7 único global; base da deduplicação (RN-MSG-B-010). */
  eventId: Type.String({ format: 'uuid' }),
  /** `<contexto>.<fato>`; o contexto pode ter `_` (`market_data.*`, `session_schedule.updated`). */
  eventType: Type.String({ pattern: '^[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_]*)+$' }),
  eventVersion: Type.Integer({ minimum: 1 }),
  source: Type.String({ minLength: 1 }),
  environment: Type.String({ minLength: 1 }),
  /** Tempo do relógio do ambiente (RN-MSG-B-011). */
  occurredAt: Type.String({ format: 'date-time' }),
  /** Preenchido pelo relay ao publicar. */
  publishedAt: Type.Optional(Type.String({ format: 'date-time' })),
  partitionKey: Type.String({ minLength: 1 }),
  correlationId: Type.String({ minLength: 1 }),
  causationId: Type.Optional(Type.String({ minLength: 1 })),
  actor: Actor,
  traceparent: Type.Optional(Type.String()),
  auditable: Type.Boolean(),
  payload: Type.Record(Type.String(), Type.Unknown()),
});

export type Envelope<P = Record<string, unknown>> = Omit<
  Static<typeof EnvelopeSchema>,
  'payload'
> & { payload: P };
export type Actor = Static<typeof Actor>;

/**
 * Lê uma mensagem do barramento. Falha com erro permanente (vai direto para a DLQ) se não for
 * JSON, se faltar campo obrigatório do envelope ou se o ambiente for outro (RN-MSG-B-012).
 */
export function parseEnvelope(raw: Buffer | string, expectedEnvironment: Environment): Envelope {
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    throw new InvalidMessageError('mensagem não é JSON');
  }
  const errors = validationErrors(EnvelopeSchema, value);
  if (errors.length > 0) throw new InvalidMessageError(`envelope inválido: ${errors.join('; ')}`);
  const envelope = value as Envelope;
  if (envelope.environment !== expectedEnvironment) {
    throw new InvalidMessageError(
      `mensagem do ambiente '${envelope.environment}' recusada pelo ambiente '${expectedEnvironment}' (RN-MSG-B-012)`,
    );
  }
  return envelope;
}
