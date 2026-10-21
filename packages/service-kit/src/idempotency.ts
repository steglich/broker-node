import { createHash } from 'node:crypto';
import type { Valkey } from 'iovalkey';
import { sql, type Kysely } from 'kysely';
import { conflict } from './errors.js';

export interface StoredResponse {
  status: number;
  body: unknown;
}

export type IdempotencyDecision = { kind: 'NEW' } | { kind: 'REPLAY'; response: StoredResponse };

/** JSON com chaves ordenadas: o mesmo corpo dá o mesmo hash independentemente da ordem dos campos. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const requestHash = (method: string, path: string, body: unknown): string =>
  createHash('sha256')
    .update(`${method.toUpperCase()} ${path}\n${canonical(body ?? null)}`)
    .digest('hex');

/**
 * Idempotência de comandos HTTP (RN-PAD §4, RNF-032): a mesma `Idempotency-Key` com o mesmo corpo
 * devolve a mesma resposta por 24 h; com outro corpo, `409 IDEMPOTENCY_KEY_REUSED`.
 *
 * O banco (`idempotency_record`) é a fonte da verdade: a chave é "reservada" com um INSERT antes do
 * caso de uso, o que impede duas execuções simultâneas. O Valkey é só o caminho rápido para as
 * repetições (D16). Respostas 5xx não são guardadas: o cliente pode tentar de novo.
 */
export class IdempotencyStore {
  constructor(
    private readonly options: { db: Kysely<unknown>; valkey?: Valkey; ttlHours?: number },
  ) {}

  private get ttlHours(): number {
    return this.options.ttlHours ?? 24;
  }

  private cacheKey = (actorId: string, key: string) => `idem:${actorId}:${key}`;

  async begin(actorId: string, key: string, hash: string): Promise<IdempotencyDecision> {
    const cached = await this.options.valkey?.get(this.cacheKey(actorId, key)).catch(() => null);
    if (cached) {
      const entry = JSON.parse(cached) as { hash: string } & StoredResponse;
      if (entry.hash !== hash)
        throw conflict(
          'IDEMPOTENCY_KEY_REUSED',
          'Esta Idempotency-Key já foi usada com outra requisição.',
        );
      return { kind: 'REPLAY', response: { status: entry.status, body: entry.body } };
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const claimed = await sql`
        INSERT INTO idempotency_record (key, actor_id, request_hash, expires_at)
        VALUES (${key}, ${actorId}, ${hash}, now() + make_interval(hours => ${this.ttlHours}))
        ON CONFLICT DO NOTHING RETURNING key`.execute(this.options.db);
      if (claimed.rows.length > 0) return { kind: 'NEW' };

      const row = (
        await sql<{
          request_hash: string;
          response_status: number | null;
          response_body: unknown;
          expired: boolean;
        }>`
          SELECT request_hash, response_status, response_body, expires_at < now() AS expired
          FROM idempotency_record WHERE actor_id = ${actorId} AND key = ${key}`.execute(
          this.options.db,
        )
      ).rows[0];
      if (!row) continue; // foi apagada entre o INSERT e o SELECT: tenta de novo
      if (row.expired) {
        await sql`DELETE FROM idempotency_record WHERE actor_id = ${actorId} AND key = ${key} AND expires_at < now()`.execute(
          this.options.db,
        );
        continue;
      }
      if (row.request_hash !== hash) {
        throw conflict(
          'IDEMPOTENCY_KEY_REUSED',
          'Esta Idempotency-Key já foi usada com outra requisição.',
        );
      }
      if (row.response_status === null) {
        throw conflict(
          'IDEMPOTENCY_REQUEST_IN_PROGRESS',
          'A requisição original ainda está sendo processada.',
        );
      }
      return { kind: 'REPLAY', response: { status: row.response_status, body: row.response_body } };
    }
    throw conflict('IDEMPOTENCY_REQUEST_IN_PROGRESS', 'Tente novamente.');
  }

  async complete(
    actorId: string,
    key: string,
    hash: string,
    response: StoredResponse,
  ): Promise<void> {
    await sql`
      UPDATE idempotency_record SET response_status = ${response.status}, response_body = ${JSON.stringify(response.body ?? null)}::jsonb
      WHERE actor_id = ${actorId} AND key = ${key}`.execute(this.options.db);
    await this.options.valkey
      ?.set(
        this.cacheKey(actorId, key),
        JSON.stringify({ hash, ...response }),
        'EX',
        this.ttlHours * 3600,
      )
      .catch(() => undefined);
  }

  /** Falha técnica: libera a chave para o cliente poder repetir. */
  async abandon(actorId: string, key: string): Promise<void> {
    await sql`DELETE FROM idempotency_record WHERE actor_id = ${actorId} AND key = ${key}`.execute(
      this.options.db,
    );
  }
}
