import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { TSchema } from 'typebox';
import { validationError, type FieldError } from './errors.js';

/** Corpo: sem coerção (JSON já tem tipos). Query e params: strings convertidas para o tipo do esquema. */
const bodyAjv = new Ajv2020({ allErrors: true, strict: false });
const queryAjv = new Ajv2020({
  allErrors: true,
  strict: false,
  coerceTypes: 'array',
  useDefaults: true,
});
addFormats.default(bodyAjv);
addFormats.default(queryAjv);

const cache = new WeakMap<object, { body?: ValidateFunction; query?: ValidateFunction }>();

function compiled(schema: TSchema, kind: 'body' | 'query'): ValidateFunction {
  const entry = cache.get(schema) ?? {};
  entry[kind] ??= (kind === 'body' ? bodyAjv : queryAjv).compile(schema as object);
  cache.set(schema, entry);
  return entry[kind]!;
}

/** Erro do Ajv → `{ field, code, message }` (RN-BE-020: aponta o campo, sem detalhe interno). */
function toFieldError(e: ErrorObject, prefix: string): FieldError {
  const path = e.instancePath.split('/').filter(Boolean).join('.');
  const missing =
    e.keyword === 'required'
      ? (e.params as { missingProperty: string }).missingProperty
      : undefined;
  const field = [prefix, path, missing].filter(Boolean).join('.');
  const code =
    {
      required: 'REQUIRED',
      type: 'INVALID_TYPE',
      pattern: 'INVALID_FORMAT',
      format: 'INVALID_FORMAT',
      enum: 'INVALID_VALUE',
      const: 'INVALID_VALUE',
      anyOf: 'INVALID_VALUE',
      additionalProperties: 'UNKNOWN_FIELD',
    }[e.keyword] ?? e.keyword.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
  return { field: field || prefix, code, message: e.message ?? 'inválido' };
}

/** Valida e devolve o valor (com coerção/padrões em query e params). Inválido → `400 VALIDATION_ERROR`. */
export function validateInput<T>(
  schema: TSchema,
  value: unknown,
  part: 'body' | 'query' | 'params',
): T {
  const fn = compiled(schema, part === 'body' ? 'body' : 'query');
  const copy = part === 'body' ? value : { ...(value as object) };
  if (!fn(copy))
    throw validationError(
      (fn.errors ?? []).map((e) => toFieldError(e, part === 'body' ? '' : part)),
    );
  return copy as T;
}
