import type { JsonSchema } from './generate.js';

/**
 * Compatibilidade de esquemas de evento (RN-MSG-B-021). Dentro da mesma `eventVersion` só é
 * compatível ADICIONAR campo opcional. Qualquer outra mudança é incompatível e exige `v<N+1>`:
 *
 * - remover campo, ou torná-lo obrigatório/opcional (mudança no `required`);
 * - adicionar campo obrigatório;
 * - mudar `type`, `format`, `const`, `enum`, restrições (`pattern`, `minimum`, `maxLength`…)
 *   ou composições (`anyOf`, `oneOf`, `allOf`).
 *
 * A regra é conservadora de propósito: um consumidor com o esquema antigo precisa continuar
 * entendendo tudo o que o produtor publica com o esquema novo, e vice-versa durante a migração.
 */
export interface Incompatibility {
  /** Caminho JSON do ponto da mudança, ex.: `payload.items[].price`. */
  path: string;
  message: string;
}

const CONSTRAINTS = [
  'type',
  'format',
  'const',
  'enum',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'additionalProperties',
  'anyOf',
  'oneOf',
  'allOf',
] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const show = (v: unknown) => (v === undefined ? '(ausente)' : JSON.stringify(v));

export function compareSchemas(
  before: JsonSchema,
  after: JsonSchema,
  path = 'payload',
): Incompatibility[] {
  const out: Incompatibility[] = [];
  for (const key of CONSTRAINTS) {
    if (!same(before[key], after[key])) {
      out.push({
        path,
        message: `'${key}' mudou de ${show(before[key])} para ${show(after[key])}`,
      });
    }
  }

  const beforeProps = (before['properties'] ?? {}) as Record<string, JsonSchema>;
  const afterProps = (after['properties'] ?? {}) as Record<string, JsonSchema>;
  const beforeRequired = new Set((before['required'] as string[] | undefined) ?? []);
  const afterRequired = new Set((after['required'] as string[] | undefined) ?? []);

  for (const [name, prop] of Object.entries(beforeProps)) {
    const child = `${path}.${name}`;
    const next = afterProps[name];
    if (!next) {
      out.push({
        path: child,
        message: beforeRequired.has(name)
          ? 'campo obrigatório removido'
          : 'campo opcional removido',
      });
      continue;
    }
    if (beforeRequired.has(name) && !afterRequired.has(name)) {
      out.push({ path: child, message: 'campo obrigatório passou a opcional' });
    } else if (!beforeRequired.has(name) && afterRequired.has(name)) {
      out.push({ path: child, message: 'campo opcional passou a obrigatório' });
    }
    out.push(...compareSchemas(prop, next, child));
  }
  for (const name of Object.keys(afterProps)) {
    if (!(name in beforeProps) && afterRequired.has(name)) {
      out.push({ path: `${path}.${name}`, message: 'campo obrigatório adicionado' });
    }
  }

  const beforeItems = before['items'] as JsonSchema | undefined;
  const afterItems = after['items'] as JsonSchema | undefined;
  if (beforeItems && afterItems) out.push(...compareSchemas(beforeItems, afterItems, `${path}[]`));
  else if (!same(beforeItems, afterItems))
    out.push({ path: `${path}[]`, message: "'items' mudou" });

  return out;
}

export interface VersionedSchemas {
  /** `eventType` → versão → JSON Schema do payload. */
  [eventType: string]: Record<number, JsonSchema>;
}

export interface CompatibilityReport {
  ok: boolean;
  problems: string[];
}

/**
 * Compara o registro atual com o da base (`main`):
 * - versão que existia e mudou de forma incompatível → reprova (deveria ter virado `v<N+1>`);
 * - versão removida → reprova, a menos que `allowRemoved` (fim dos 30 dias de dupla publicação);
 * - as versões de um evento são consecutivas (sem buracos).
 */
export function checkCompatibility(
  base: VersionedSchemas,
  current: VersionedSchemas,
  options: { allowRemoved?: readonly string[] } = {},
): CompatibilityReport {
  const problems: string[] = [];
  const allowRemoved = new Set(options.allowRemoved ?? []);

  for (const [eventType, versions] of Object.entries(base)) {
    for (const [version, schema] of Object.entries(versions)) {
      const id = `${eventType} v${version}`;
      const next = current[eventType]?.[Number(version)];
      if (!next) {
        if (!allowRemoved.has(id)) {
          problems.push(
            `${id}: versão removida (o produtor publica as duas versões por 30 dias, RN-MSG-B-021)`,
          );
        }
        continue;
      }
      for (const p of compareSchemas(schema, next)) {
        problems.push(
          `${id}: ${p.path}: ${p.message} — crie v${maxVersion(current[eventType]!) + 1}`,
        );
      }
    }
  }

  for (const [eventType, versions] of Object.entries(current)) {
    const numbers = Object.keys(versions)
      .map(Number)
      .sort((a, b) => a - b);
    numbers.forEach((n, i) => {
      if (n !== numbers[0]! + i)
        problems.push(`${eventType}: versões fora de sequência (${numbers.join(', ')})`);
    });
  }

  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

function maxVersion(versions: Record<number, JsonSchema>): number {
  return Math.max(...Object.keys(versions).map(Number));
}
