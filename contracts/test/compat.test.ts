import { describe, expect, it } from 'vitest';
import { checkCompatibility, compareSchemas, type JsonSchema } from '../src/index.js';

const v1: JsonSchema = {
  type: 'object',
  required: ['orderId', 'quantity'],
  properties: {
    orderId: { type: 'string', format: 'uuid' },
    quantity: { type: 'string' },
    note: { type: 'string' },
    fills: {
      type: 'array',
      items: { type: 'object', required: ['price'], properties: { price: { type: 'string' } } },
    },
  },
};
const clone = (s: JsonSchema) =>
  structuredClone(s) as JsonSchema & { properties: Record<string, JsonSchema>; required: string[] };

describe('compatibilidade de esquemas (RN-MSG-B-021)', () => {
  it('RN-MSG-B-021: adicionar campo opcional é compatível', () => {
    const next = clone(v1);
    next.properties['venue'] = { type: 'string' };
    expect(compareSchemas(v1, next)).toEqual([]);
  });

  it('RN-MSG-B-021: remover campo obrigatório é incompatível', () => {
    const next = clone(v1);
    delete next.properties['quantity'];
    next.required = ['orderId'];
    expect(compareSchemas(v1, next)).toEqual([
      { path: 'payload.quantity', message: 'campo obrigatório removido' },
    ]);
  });

  it.each([
    [
      'mudar o tipo',
      (s: ReturnType<typeof clone>) => (s.properties['quantity'] = { type: 'integer' }),
    ],
    [
      'adicionar campo obrigatório',
      (s: ReturnType<typeof clone>) => {
        s.properties['venue'] = { type: 'string' };
        s.required.push('venue');
      },
    ],
    ['tornar opcional um obrigatório', (s: ReturnType<typeof clone>) => (s.required = ['orderId'])],
    ['tornar obrigatório um opcional', (s: ReturnType<typeof clone>) => s.required.push('note')],
    ['remover campo opcional', (s: ReturnType<typeof clone>) => delete s.properties['note']],
    [
      'mudar campo dentro de array',
      (s: ReturnType<typeof clone>) => {
        (s.properties['fills']!['items'] as JsonSchema)['properties'] = {
          price: { type: 'number' },
        };
      },
    ],
  ])('RN-MSG-B-021: %s é incompatível', (_name, mutate) => {
    const next = clone(v1);
    mutate(next);
    expect(compareSchemas(v1, next)).not.toEqual([]);
  });

  it('RN-MSG-B-021: quebra sem subir versão reprova; a mesma quebra em v2 passa', () => {
    const broken = clone(v1);
    delete broken.properties['quantity'];
    broken.required = ['orderId'];

    const sameVersion = checkCompatibility(
      { 'oms.order_filled': { 1: v1 } },
      { 'oms.order_filled': { 1: broken } },
    );
    expect(sameVersion.ok).toBe(false);
    expect(sameVersion.problems[0]).toContain(
      'oms.order_filled v1: payload.quantity: campo obrigatório removido — crie v2',
    );

    const newVersion = checkCompatibility(
      { 'oms.order_filled': { 1: v1 } },
      { 'oms.order_filled': { 1: v1, 2: broken } },
    );
    expect(newVersion).toEqual({ ok: true, problems: [] });
  });

  it('RN-MSG-B-021: remover uma versão exige liberação explícita', () => {
    const base = { 'oms.order_filled': { 1: v1, 2: v1 } };
    const current = { 'oms.order_filled': { 2: v1 } };
    expect(checkCompatibility(base, current).problems).toEqual([
      'oms.order_filled v1: versão removida (o produtor publica as duas versões por 30 dias, RN-MSG-B-021)',
    ]);
    expect(checkCompatibility(base, current, { allowRemoved: ['oms.order_filled v1'] }).ok).toBe(
      true,
    );
  });

  it('versões precisam ser consecutivas', () => {
    expect(checkCompatibility({}, { 'a.b': { 1: v1, 3: v1 } }).ok).toBe(false);
  });
});
