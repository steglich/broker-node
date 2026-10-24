import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateArtifacts, loadRegistry } from '../src/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));

describe('geração de contratos (D8)', async () => {
  const registry = await loadRegistry(root);
  const files = generateArtifacts(registry);
  // JSON.parse devolve `any`: navegação livre nos documentos gerados.
  const json = (path: string) => JSON.parse(files.get(path)!);

  it('RN-MSG-B-020: cada versão de evento vira um JSON Schema no registro', () => {
    const schema = json('events/example.pinged/v1.schema.json');
    expect(schema.$id).toBe('urn:broker:event:example.pinged:v1');
    expect(schema.required).toEqual(['pingId']);
    expect(schema.properties.pingId).toEqual({ type: 'string', format: 'uuid' });
  });

  it('AsyncAPI 3: um canal por contexto com o envelope padrão e o payload da versão', () => {
    const doc = json('asyncapi.json');
    expect(doc.asyncapi).toBe('3.0.0');
    expect(doc.channels.example.address).toBe('{environment}.example.events');
    expect(doc.channels.example.messages['example.pinged.v1']).toEqual({
      $ref: '#/components/messages/example.pinged.v1',
    });
    const message = doc.components.messages['example.pinged.v1'];
    expect(message.payload.allOf[0]).toEqual({ $ref: '#/components/schemas/Envelope' });
    expect(message.payload.allOf[1].properties.payload).toEqual({
      $ref: '#/components/schemas/example.pinged.v1',
    });
    expect(doc.components.schemas.Envelope.required).toContain('eventId');
    expect(doc.operations['example-service.send.example.pinged.v1'].action).toBe('send');
  });

  it('AsyncAPI 3: contexto explícito do tópico e eventos publicados no tópico de cada produtor', () => {
    const doc = json('asyncapi.json');
    expect(doc.channels.scheduler.messages['routine.triggered.v1']).toBeDefined();
    expect(doc.channels.scheduler.messages['clock.ticked.v1']).toBeDefined();
    expect(doc.channels['owner-topics'].address).toBe('{environment}.{context}.events');
    expect(doc.channels['owner-topics'].messages['routine.completed.v1']).toBeDefined();
    expect(doc.channels.routine).toBeUndefined();
  });

  it('OpenAPI 3.1: rotas, parâmetros de caminho e Problem Details nos erros', () => {
    const doc = json('openapi/example-service.json');
    expect(doc.openapi).toBe('3.1.0');
    const get = doc.paths['/v1/pings/{id}'].get;
    expect(get.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
    ]);
    expect(get.responses['404'].content['application/problem+json'].schema).toEqual({
      $ref: '#/components/schemas/ProblemDetails',
    });
    expect(
      doc.paths['/v1/pings'].post.responses['202'].content['application/json'].schema.required,
    ).toEqual(['pingId']);
  });

  it('a saída é determinística (mesmos contratos, mesmos bytes)', () => {
    expect(generateArtifacts(registry)).toEqual(files);
  });
});
