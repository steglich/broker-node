import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/** Tabela do último instante do relógio do ambiente aplicado pelo serviço (vai em `baseMigrations`). */
export const environmentClockMigrations: Record<string, Migration> = {
  '0000_platform_environment_clock': {
    async up(db: Kysely<unknown>) {
      // Linha única: o `virtualNow` do último `clock.ticked` consumido.
      await sql`
        CREATE TABLE environment_clock (
          id           smallint PRIMARY KEY CHECK (id = 1),
          virtual_now  timestamptz NOT NULL,
          updated_at   timestamptz NOT NULL DEFAULT now()
        )`.execute(db);
    },
  },
};

/** O que a réplica precisa do relógio: o `TickedClock` de `@broker/clock`. */
export interface TickTarget {
  apply(tick: { virtualNow: string }): boolean;
}

/**
 * Réplica do relógio do ambiente (RN-CLK-003) para os serviços com relógio VIRTUAL/ACCELERATED. O
 * consumidor de `clock.ticked` grava o instante na transação dele (com a inbox e o offset), e o
 * serviço restaura o instante gravado ao subir: sem isso, um serviço reiniciado voltaria ao
 * `CLOCK_START` e só acompanharia o ambiente no próximo tick, porque o consumidor retoma do offset
 * já processado. Tick mais velho que o gravado não faz o relógio voltar.
 */
export class EnvironmentClockReplica {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly clock: TickTarget,
  ) {}

  /** Aplica o instante gravado; `true` se o relógio andou. */
  async restore(): Promise<boolean> {
    const { rows } = await sql<{ virtual_now: Date | string }>`
      SELECT virtual_now FROM environment_clock WHERE id = 1`.execute(this.db);
    const at = rows[0]?.virtual_now;
    return at ? this.clock.apply({ virtualNow: new Date(at).toISOString() }) : false;
  }

  /** Aplica um `clock.ticked` na transação do consumidor. */
  async apply(trx: Kysely<unknown>, tick: { virtualNow: string }): Promise<void> {
    this.clock.apply(tick);
    await sql`
      INSERT INTO environment_clock (id, virtual_now) VALUES (1, ${tick.virtualNow})
      ON CONFLICT (id) DO UPDATE SET virtual_now = GREATEST(environment_clock.virtual_now, EXCLUDED.virtual_now),
        updated_at = now()`.execute(trx);
  }
}
