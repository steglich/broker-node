import type { Clock } from '@broker/clock';
import { sql, type Kysely } from 'kysely';
import type { Actor, Environment } from './envelope.js';
import { PublishRejectedError } from './errors.js';
import type { EventDefinition, PayloadOf } from './events.js';
import { activeTraceparent } from './tracing.js';
import { validationErrors } from './validation.js';

/** Tamanho máximo do payload serializado (RN-MSG-B-014). */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * Nomes de campo que indicam dado pessoal (RN-MSG-B-013): CPF, documentos, endereço, contato e
 * data de nascimento nunca vão em eventos; o evento leva IDs. A comparação ignora maiúsculas,
 * `_` e `-` (`tax_id`, `taxId` e `TAX-ID` são o mesmo campo).
 */
export const DEFAULT_PERSONAL_DATA_FIELDS = [
  'cpf',
  'taxid',
  'document',
  'documentnumber',
  'rg',
  'address',
  'endereco',
  'street',
  'zipcode',
  'cep',
  'phone',
  'telefone',
  'email',
  'birthdate',
  'dateofbirth',
  'datanascimento',
  'fullname',
  'mothername',
];

const normalize = (field: string) => field.toLowerCase().replace(/[_-]/g, '');

function findPersonalData(value: unknown, blocked: Set<string>, path = ''): string | undefined {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findPersonalData(value[i], blocked, `${path}/${i}`);
      if (hit) return hit;
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (blocked.has(normalize(key))) return `${path}/${key}`;
      const hit = findPersonalData(child, blocked, `${path}/${key}`);
      if (hit) return hit;
    }
  }
  return undefined;
}

export interface PublishContext {
  /** Chave de partição (ex.: `account_id`): define a ordem no barramento (RN-PAD-022). */
  partitionKey: string;
  aggregateType: string;
  aggregateId: string;
  actor: Actor;
  /** Preservado de ponta a ponta (INV-07). Sem ele, o evento inicia uma correlação nova. */
  correlationId?: string;
  /** `eventId` da mensagem que causou esta (INV-07). */
  causationId?: string;
  traceparent?: string;
}

/** Contexto derivado de um evento recebido: mantém a correlação e aponta a causa (INV-07). */
export function causedBy(
  parent: { eventId: string; correlationId: string; traceparent?: string | undefined },
  context: Omit<PublishContext, 'correlationId' | 'causationId'>,
): PublishContext {
  return {
    ...context,
    correlationId: parent.correlationId,
    causationId: parent.eventId,
    ...(parent.traceparent ? { traceparent: parent.traceparent } : {}),
  };
}

export interface EventPublisherOptions {
  /** Nome do serviço produtor (`source` do envelope). */
  source: string;
  environment: Environment;
  clock: Clock;
  newId: () => string;
  /** Campos de dado pessoal recusados; padrão `DEFAULT_PERSONAL_DATA_FIELDS`. */
  personalDataFields?: readonly string[];
}

/**
 * Publicador de eventos de domínio via outbox (ADR-0008, RN-MSG-B-040). Grava o envelope na tabela
 * `outbox_event` **dentro da transação do caso de uso**: se ela fizer rollback, o evento some junto.
 * Quem publica no barramento é o relay. Antes de gravar, valida o payload contra o esquema, o
 * limite de 256 KB e a lista de dados pessoais: um evento inválido nem chega à outbox.
 */
export class EventPublisher {
  private readonly blockedFields: Set<string>;

  constructor(private readonly options: EventPublisherOptions) {
    this.blockedFields = new Set(
      (options.personalDataFields ?? DEFAULT_PERSONAL_DATA_FIELDS).map(normalize),
    );
  }

  async publish<D extends EventDefinition>(
    trx: Kysely<unknown>,
    definition: D,
    payload: PayloadOf<D>,
    context: PublishContext,
  ): Promise<string> {
    const errors = validationErrors(definition.payload, payload);
    if (errors.length > 0) {
      throw new PublishRejectedError(
        'SCHEMA',
        `payload de ${definition.eventType} v${definition.eventVersion} inválido: ${errors.join('; ')}`,
      );
    }
    const personal = findPersonalData(payload, this.blockedFields);
    if (personal) {
      throw new PublishRejectedError(
        'PERSONAL_DATA',
        `dado pessoal no payload (${personal}): use IDs (RN-MSG-B-013)`,
      );
    }
    const serialized = JSON.stringify(payload);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > MAX_PAYLOAD_BYTES) {
      throw new PublishRejectedError(
        'PAYLOAD_TOO_LARGE',
        `payload de ${bytes} bytes passa do limite de ${MAX_PAYLOAD_BYTES} (RN-MSG-B-014): grave no storage e envie a referência`,
      );
    }

    const eventId = this.options.newId();
    // Sem traceparent explícito, usa o do span ativo (ex.: a requisição HTTP que causou o evento).
    const traceparent = context.traceparent ?? activeTraceparent();
    const headers = {
      source: this.options.source,
      environment: this.options.environment,
      correlationId: context.correlationId ?? eventId,
      ...(context.causationId ? { causationId: context.causationId } : {}),
      actor: context.actor,
      ...(traceparent ? { traceparent } : {}),
      auditable: definition.auditable,
    };
    await sql`
      INSERT INTO outbox_event
        (id, aggregate_type, aggregate_id, event_type, event_version, partition_key, payload, headers, occurred_at)
      VALUES
        (${eventId}, ${context.aggregateType}, ${context.aggregateId}, ${definition.eventType}, ${definition.eventVersion},
         ${context.partitionKey}, ${serialized}::jsonb, ${JSON.stringify(headers)}::jsonb, ${this.options.clock.now().toString()})`.execute(
      trx,
    );
    // Acorda o relay; o NOTIFY só é entregue no commit (D7).
    await sql`SELECT pg_notify('outbox_event', '')`.execute(trx);
    return eventId;
  }
}
