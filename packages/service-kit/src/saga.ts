import { sql, type Kysely } from 'kysely';
import type { Logger } from './logger.js';

export type SagaState = 'RUNNING' | 'COMPENSATING' | 'COMPLETED' | 'COMPENSATED' | 'FAILED';

export interface SagaStep<D> {
  name: string;
  /** Tempo máximo do passo (RN-PAD-031). Estourado, conta como falha. */
  timeoutMs: number;
  /** Passo idempotente pode ser repetido (falha, timeout ou retomada após queda). */
  idempotent: boolean;
  /** Tentativas antes de compensar (padrão 3; 1 se não for idempotente). */
  maxAttempts?: number;
  run: (data: D, meta: { sagaId: string; attempt: number }) => Promise<D>;
  /** Desfaz o efeito do passo quando um passo seguinte falha de vez. */
  compensate?: (data: D, meta: { sagaId: string }) => Promise<D>;
}

export interface SagaDefinition<D> {
  type: string;
  steps: SagaStep<D>[];
}

interface SagaRow {
  id: string;
  saga_type: string;
  state: SagaState;
  step: string;
  data: unknown;
  attempts: number;
  version: number;
}

class StepTimeoutError extends Error {
  override readonly name = 'StepTimeoutError';
}

function withTimeout<T>(promise: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new StepTimeoutError(`passo ${step} passou de ${ms} ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Orquestrador de sagas (RN-PAD-030/031) sobre a tabela `saga_instance`.
 *
 * - O estado (passo atual, dados, tentativas) é gravado depois de cada passo: após um reinício,
 *   `resumePending()` continua do passo em que parou.
 * - Antes de executar um passo, a instância ganha um *lease* (`deadline_at = agora + timeout`).
 *   Enquanto ele vale, outra instância do serviço não pega a mesma saga; se o processo morrer,
 *   o lease vence e a saga volta a ser retomável. Por isso passos retomáveis precisam ser
 *   idempotentes: o passo interrompido roda de novo.
 * - Falha ou timeout: repete (se idempotente, até `maxAttempts`) ou compensa os passos já feitos,
 *   na ordem inversa.
 */
export class SagaOrchestrator {
  private readonly definitions: Map<string, SagaDefinition<unknown>>;

  constructor(
    private readonly options: {
      db: Kysely<unknown>;
      definitions: SagaDefinition<never>[];
      newId: () => string;
      logger?: Logger;
    },
  ) {
    this.definitions = new Map(
      options.definitions.map((d) => [d.type, d as unknown as SagaDefinition<unknown>]),
    );
  }

  /** Cria a saga e executa até terminar (ou até o processo cair). */
  async start<D>(type: string, data: D): Promise<{ id: string; state: SagaState; data: D }> {
    const def = this.definition(type);
    const id = this.options.newId();
    await sql`
      INSERT INTO saga_instance (id, saga_type, state, step, data)
      VALUES (${id}, ${type}, 'RUNNING', ${def.steps[0]!.name}, ${JSON.stringify(data)}::jsonb)`.execute(
      this.options.db,
    );
    return this.run(id) as Promise<{ id: string; state: SagaState; data: D }>;
  }

  /** Retoma as sagas interrompidas (lease vencido). Chame ao iniciar o serviço e periodicamente. */
  async resumePending(): Promise<string[]> {
    const ids = (
      await sql<{ id: string }>`
        SELECT id FROM saga_instance
        WHERE state IN ('RUNNING', 'COMPENSATING') AND (deadline_at IS NULL OR deadline_at < now())
        ORDER BY created_at`.execute(this.options.db)
    ).rows.map((r) => r.id);
    const resumed: string[] = [];
    for (const id of ids) {
      if ((await this.run(id)).state !== 'RUNNING') resumed.push(id);
    }
    return resumed;
  }

  async get(
    id: string,
  ): Promise<{ state: SagaState; step: string; data: unknown; attempts: number } | undefined> {
    const row = (
      await sql<SagaRow>`SELECT * FROM saga_instance WHERE id = ${id}`.execute(this.options.db)
    ).rows[0];
    return row && { state: row.state, step: row.step, data: row.data, attempts: row.attempts };
  }

  private definition(type: string): SagaDefinition<unknown> {
    const def = this.definitions.get(type);
    if (!def) throw new Error(`saga não registrada: ${type}`);
    return def;
  }

  /** Pega o lease da instância; devolve a linha ou `undefined` se outra instância estiver com ela. */
  private async lease(id: string, timeoutMs: number): Promise<SagaRow | undefined> {
    return (
      await sql<SagaRow>`
        UPDATE saga_instance
        SET deadline_at = now() + make_interval(secs => ${timeoutMs / 1000 + 1}), attempts = attempts + 1,
            version = version + 1, updated_at = now()
        WHERE id = ${id} AND state IN ('RUNNING', 'COMPENSATING') AND (deadline_at IS NULL OR deadline_at < now())
        RETURNING *`.execute(this.options.db)
    ).rows[0];
  }

  private async save(
    id: string,
    fields: { state?: SagaState; step?: string; data?: unknown; resetAttempts?: boolean },
  ): Promise<void> {
    await sql`
      UPDATE saga_instance SET
        state = COALESCE(${fields.state ?? null}, state),
        step = COALESCE(${fields.step ?? null}, step),
        data = COALESCE(${fields.data === undefined ? null : JSON.stringify(fields.data)}::jsonb, data),
        attempts = CASE WHEN ${fields.resetAttempts ?? false} THEN 0 ELSE attempts END,
        deadline_at = NULL, version = version + 1, updated_at = now()
      WHERE id = ${id}`.execute(this.options.db);
  }

  private async run(id: string): Promise<{ id: string; state: SagaState; data: unknown }> {
    for (;;) {
      const current = (
        await sql<SagaRow>`SELECT * FROM saga_instance WHERE id = ${id}`.execute(this.options.db)
      ).rows[0];
      if (!current) throw new Error(`saga não encontrada: ${id}`);
      if (current.state !== 'RUNNING' && current.state !== 'COMPENSATING')
        return { id, state: current.state, data: current.data };
      const def = this.definition(current.saga_type);
      const index = def.steps.findIndex((s) => s.name === current.step);
      const step = def.steps[index]!;

      if (current.state === 'COMPENSATING') {
        await this.compensateFrom(id, def, index, current.data);
        continue;
      }

      const row = await this.lease(id, step.timeoutMs);
      if (!row) return { id, state: current.state, data: current.data }; // outra instância está executando
      try {
        const data = await withTimeout(
          step.run(row.data, { sagaId: id, attempt: row.attempts }),
          step.timeoutMs,
          step.name,
        );
        const next = def.steps[index + 1];
        await this.save(
          id,
          next
            ? { step: next.name, data, resetAttempts: true }
            : { state: 'COMPLETED', data, resetAttempts: true },
        );
      } catch (err) {
        const max = step.idempotent ? (step.maxAttempts ?? 3) : 1;
        this.options.logger?.warn(
          { event: 'saga.step_failed', saga_id: id, step: step.name, attempt: row.attempts, err },
          'passo da saga falhou',
        );
        if (row.attempts < max) {
          await this.save(id, {}); // libera o lease e tenta de novo
        } else {
          // Compensa os passos anteriores (o que falhou não terminou, então não tem o que desfazer).
          await this.save(id, {
            state: 'COMPENSATING',
            step: def.steps[Math.max(index - 1, 0)]!.name,
            resetAttempts: true,
          });
          if (index === 0) await this.save(id, { state: 'COMPENSATED' });
        }
      }
    }
  }

  private async compensateFrom(
    id: string,
    def: SagaDefinition<unknown>,
    index: number,
    data: unknown,
  ): Promise<void> {
    let current = data;
    for (let i = index; i >= 0; i--) {
      const step = def.steps[i]!;
      try {
        if (step.compensate)
          current = await withTimeout(
            step.compensate(current, { sagaId: id }),
            step.timeoutMs,
            `${step.name}:compensate`,
          );
        const prev = def.steps[i - 1];
        await this.save(
          id,
          prev ? { step: prev.name, data: current } : { state: 'COMPENSATED', data: current },
        );
      } catch (err) {
        this.options.logger?.error(
          { event: 'saga.compensation_failed', saga_id: id, step: step.name, err },
          'compensação falhou',
        );
        await this.save(id, { state: 'FAILED' });
        return;
      }
    }
  }
}
