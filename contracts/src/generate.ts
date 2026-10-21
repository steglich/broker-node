import { EnvelopeSchema } from '@broker/messaging';
import type { TSchema } from 'typebox';
import type { EventContract, HttpContract, HttpRouteContract } from './define.js';
import type { Registry } from './registry.js';

export type JsonSchema = Record<string, unknown>;

/** O esquema TypeBox já é JSON Schema; a serialização descarta os símbolos internos do TypeBox. */
export function toJsonSchema(schema: TSchema): JsonSchema {
  return JSON.parse(JSON.stringify(schema)) as JsonSchema;
}

export const eventKey = (c: EventContract) =>
  `${c.definition.eventType}.v${c.definition.eventVersion}`;

/** Caminho do esquema gerado, relativo a `contracts/generated/`. */
export const eventSchemaPath = (eventType: string, version: number) =>
  `events/${eventType}/v${version}.schema.json`;

/** JSON Schema 2020-12 do payload de uma versão de evento: é o que o check de compatibilidade compara. */
export function eventJsonSchema(contract: EventContract): JsonSchema {
  const { eventType, eventVersion } = contract.definition;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:broker:event:${eventType}:v${eventVersion}`,
    title: `${eventType} v${eventVersion}`,
    description: contract.summary,
    'x-producer': contract.producer,
    'x-auditable': contract.definition.auditable,
    ...toJsonSchema(contract.definition.payload),
  };
}

/** Contexto do tópico = primeiro segmento do `eventType` (`ledger.entry_posted` → `ledger`). */
const contextOf = (eventType: string) => eventType.split('.')[0]!;

/**
 * Um documento AsyncAPI 3 com todos os eventos. Cada contexto é um canal (super stream
 * `<ambiente>.<contexto>.events`, RN-MSG-B-001); cada versão de evento é uma mensagem com o
 * envelope padrão (RN-MSG-B §4) e o payload da versão.
 */
export function asyncApiDocument(events: readonly EventContract[]): JsonSchema {
  const channels: Record<string, JsonSchema> = {};
  const operations: Record<string, JsonSchema> = {};
  const messages: Record<string, JsonSchema> = {};
  const schemas: Record<string, JsonSchema> = { Envelope: toJsonSchema(EnvelopeSchema) };

  for (const contract of events) {
    const { eventType, eventVersion, auditable } = contract.definition;
    const key = eventKey(contract);
    const context = contextOf(eventType);
    schemas[key] = toJsonSchema(contract.definition.payload);
    messages[key] = {
      name: eventType,
      title: `${eventType} v${eventVersion}`,
      summary: contract.summary,
      contentType: 'application/json',
      payload: {
        allOf: [
          { $ref: '#/components/schemas/Envelope' },
          {
            type: 'object',
            properties: {
              eventType: { const: eventType },
              eventVersion: { const: eventVersion },
              auditable: { const: auditable },
              payload: { $ref: `#/components/schemas/${key}` },
            },
          },
        ],
      },
      'x-producer': contract.producer,
      'x-consumers': [...(contract.consumers ?? [])],
    };
    const channel = (channels[context] ??= {
      address: `{environment}.${context}.events`,
      parameters: { environment: { description: 'Ambiente isolado (RN-PAD-080).' } },
      messages: {},
    });
    (channel['messages'] as JsonSchema)[key] = { $ref: `#/components/messages/${key}` };
    operations[`${contract.producer}.send.${key}`] = {
      action: 'send',
      channel: { $ref: `#/channels/${context}` },
      messages: [{ $ref: `#/channels/${context}/messages/${key}` }],
    };
  }

  return {
    asyncapi: '3.0.0',
    info: {
      title: 'broker-node: eventos',
      version: '1.0.0',
      description:
        'Gerado de contracts/events (D8). Não edite à mão: rode `pnpm contracts:generate`.',
    },
    defaultContentType: 'application/json',
    channels,
    operations,
    components: { schemas, messages },
  };
}

const ProblemDetails: JsonSchema = {
  type: 'object',
  description: 'Problem Details (RFC 9457, RN-BE-030).',
  required: ['type', 'title', 'status', 'code', 'instance', 'correlationId'],
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string' },
    code: { type: 'string' },
    correlationId: { type: 'string' },
    errors: { type: 'array', items: { type: 'object' } },
    context: { type: 'object' },
  },
};

function parametersOf(route: HttpRouteContract): JsonSchema[] {
  const out: JsonSchema[] = [];
  for (const [where, schema] of [
    ['path', route.params],
    ['query', route.query],
  ] as const) {
    if (!schema) continue;
    const json = toJsonSchema(schema);
    const required = new Set((json['required'] as string[] | undefined) ?? []);
    for (const [name, prop] of Object.entries((json['properties'] ?? {}) as JsonSchema)) {
      out.push({ name, in: where, required: where === 'path' || required.has(name), schema: prop });
    }
  }
  if (route.idempotent) {
    out.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      schema: { type: 'string', minLength: 1 },
    });
  }
  return out;
}

/** OpenAPI 3.1 de um serviço a partir do contrato HTTP. */
export function openApiDocument(contract: HttpContract): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const [operationId, route] of Object.entries(contract.routes)) {
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const responses: Record<string, JsonSchema> = {};
    for (const [status, response] of Object.entries(route.responses)) {
      const isError = Number(status) >= 400;
      responses[status] = {
        description: response.description,
        ...(isError
          ? {
              content: {
                'application/problem+json': {
                  schema: { $ref: '#/components/schemas/ProblemDetails' },
                },
              },
            }
          : response.body
            ? { content: { 'application/json': { schema: toJsonSchema(response.body) } } }
            : {}),
      };
    }
    const parameters = parametersOf(route);
    (paths[path] ??= {})[route.method] = {
      operationId,
      summary: route.summary,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: toJsonSchema(route.body) } },
            },
          }
        : {}),
      responses,
      security: route.auth === 'public' ? [] : [{ [route.auth]: [] }],
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: contract.title,
      version: contract.version,
      description:
        'Gerado de contracts/http (D8). Não edite à mão: rode `pnpm contracts:generate`.',
    },
    paths,
    components: {
      schemas: { ProblemDetails },
      securitySchemes: {
        user: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        service: {
          type: 'oauth2',
          flows: { clientCredentials: { tokenUrl: '/oauth/token', scopes: {} } },
        },
      },
    },
  };
}

/** Todos os artefatos gerados, por caminho relativo a `contracts/generated/`. */
export function generateArtifacts(registry: Registry): Map<string, string> {
  const files = new Map<string, string>();
  const write = (path: string, value: unknown) =>
    files.set(path, `${JSON.stringify(value, null, 2)}\n`);
  for (const contract of registry.events) {
    const { eventType, eventVersion } = contract.definition;
    write(eventSchemaPath(eventType, eventVersion), eventJsonSchema(contract));
  }
  write('asyncapi.json', asyncApiDocument(registry.events));
  for (const contract of registry.http) {
    write(`openapi/${contract.service}.json`, openApiDocument(contract));
  }
  return files;
}
