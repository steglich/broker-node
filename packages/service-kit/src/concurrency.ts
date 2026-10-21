import { sql, type Kysely } from 'kysely';
import { conflict, HttpError } from './errors.js';

/** ETag forte a partir da `version` do agregado (RN-API §3). */
export const etag = (version: number | bigint): string => `"${version}"`;

/** Lê `If-Match` (`"3"` ou `W/"3"`). Ausente → `428 IF_MATCH_REQUIRED`. */
export function requireIfMatch(header: string | undefined): number {
  if (!header)
    throw new HttpError(
      428,
      'IF_MATCH_REQUIRED',
      'Envie o cabeçalho If-Match com a versão (ETag) do recurso.',
    );
  const m = /^(?:W\/)?"(\d+)"$/.exec(header.trim());
  if (!m)
    throw new HttpError(400, 'VALIDATION_ERROR', 'If-Match inválido.', {
      errors: [{ field: 'If-Match', code: 'INVALID_FORMAT', message: 'Use o ETag recebido.' }],
    });
  return Number(m[1]);
}

export const versionConflict = () =>
  conflict(
    'VERSION_CONFLICT',
    'O recurso foi alterado por outra operação. Recarregue e tente de novo.',
  );

/**
 * Atualização com concorrência otimista (RN-BE-041): só aplica se a `version` ainda for a
 * esperada, e incrementa a versão. Senão, `409 VERSION_CONFLICT`. Devolve a nova versão.
 */
export async function updateVersioned(
  db: Kysely<unknown>,
  args: { table: string; id: string; expectedVersion: number; set: Record<string, unknown> },
): Promise<number> {
  const assignments = Object.entries(args.set).map(
    ([col, value]) => sql`${sql.id(col)} = ${value}`,
  );
  const result = await sql<{ version: number }>`
    UPDATE ${sql.table(args.table)}
    SET ${sql.join([...assignments, sql`version = version + 1`])}
    WHERE id = ${args.id} AND version = ${args.expectedVersion}
    RETURNING version`.execute(db);
  const row = result.rows[0];
  if (!row) throw versionConflict();
  return Number(row.version);
}

/**
 * Para comandos idempotentes vindos de evento: em conflito de versão, repete do zero até
 * `attempts` vezes (RN-BE-041: até 3). Comandos da API devolvem o 409 ao cliente.
 */
export async function retryOnVersionConflict<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof HttpError && err.code === 'VERSION_CONFLICT') || i >= attempts)
        throw err;
    }
  }
}
