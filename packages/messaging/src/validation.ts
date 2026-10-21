import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { TSchema } from 'typebox';

/**
 * Ajv compartilhado (D2: TypeBox define o esquema, Ajv valida em runtime). Sem `removeAdditional`
 * e sem `additionalProperties: false` nos esquemas: o consumidor ignora campos desconhecidos
 * (tolerant reader, RN-MSG-B-022).
 */
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);

const cache = new WeakMap<object, ValidateFunction>();

export function compile(schema: TSchema): ValidateFunction {
  let fn = cache.get(schema);
  if (!fn) {
    fn = ajv.compile(schema as object);
    cache.set(schema, fn);
  }
  return fn;
}

/** Valida e devolve a lista de erros legível (vazia se válido). */
export function validationErrors(schema: TSchema, value: unknown): string[] {
  const fn = compile(schema);
  if (fn(value)) return [];
  return (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'inválido'}`);
}
