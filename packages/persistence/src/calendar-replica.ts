import { TradingCalendar, type CalendarData } from '@broker/calendar';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Tabela da cópia local do calendário (D15), para os serviços que usam calendário. Monte assim:
 * `{ ...baseMigrations, ...calendarReplicaMigrations, ... }`.
 */
export const calendarReplicaMigrations: Record<string, Migration> = {
  '0000_platform_calendar_replica': {
    async up(db: Kysely<unknown>) {
      // Linha única: o último calendário recebido do reference-data-service.
      await sql`
        CREATE TABLE calendar_replica (
          id               smallint PRIMARY KEY CHECK (id = 1),
          version          integer NOT NULL,
          data             jsonb NOT NULL,
          source_event_id  text NOT NULL,
          occurred_at      timestamptz NOT NULL,
          updated_at       timestamptz NOT NULL DEFAULT now()
        )`.execute(db);
    },
  },
};

/**
 * Cópia local do calendário (D15, RN-CAL-002): o serviço segue usando a mesma instância de
 * `TradingCalendar` (a semente, enquanto nada chegou) e ela passa a responder com os dados de cada
 * `calendar.updated`/`session_schedule.updated`, sem chamada síncrona ao dono.
 *
 * O consumidor grava na transação dele (com a inbox e o offset) e troca a memória na hora. As
 * outras instâncias, que não são a consumidora ativa (SAC), acompanham por `refresh`, que só relê
 * os dados quando a versão gravada muda. Se a transação do consumidor desfizer, a versão em memória
 * fica diferente da gravada e o próximo `refresh` volta ao que está no banco.
 */
export class CalendarReplica {
  private version = 0;

  constructor(
    private readonly db: Kysely<unknown>,
    readonly calendar: TradingCalendar,
  ) {}

  /** Carrega a cópia gravada quando ela mudou; `true` se trocou os dados em memória. */
  async refresh(): Promise<boolean> {
    const { rows } = await sql<{ version: number }>`
      SELECT version FROM calendar_replica WHERE id = 1`.execute(this.db);
    const version = rows[0]?.version;
    if (version === undefined || version === this.version) return false;
    const full = (
      await sql<{ version: number; data: CalendarData }>`
        SELECT version, data FROM calendar_replica WHERE id = 1`.execute(this.db)
    ).rows[0]!;
    this.calendar.replace(full.data);
    this.version = full.version;
    return true;
  }

  /**
   * Aplica o calendário de um evento na transação do consumidor. Valida antes de gravar (dados
   * inválidos lançam e o evento segue o caminho de retentativa/DLQ) e ignora evento mais velho que
   * o gravado. Devolve `false` quando ignorou.
   */
  async apply(
    trx: Kysely<unknown>,
    input: { data: CalendarData; eventId: string; occurredAt: string },
  ): Promise<boolean> {
    new TradingCalendar(input.data);
    const current = (
      await sql<{ version: number; newer: boolean }>`
        SELECT version, occurred_at > ${input.occurredAt}::timestamptz AS newer
        FROM calendar_replica WHERE id = 1 FOR UPDATE`.execute(trx)
    ).rows[0];
    if (current?.newer) return false;
    const version = (current?.version ?? 0) + 1;
    await sql`
      INSERT INTO calendar_replica (id, version, data, source_event_id, occurred_at)
      VALUES (1, ${version}, ${JSON.stringify(input.data)}, ${input.eventId}, ${input.occurredAt})
      ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, data = EXCLUDED.data,
        source_event_id = EXCLUDED.source_event_id, occurred_at = EXCLUDED.occurred_at,
        updated_at = now()`.execute(trx);
    this.calendar.replace(input.data);
    this.version = version;
    return true;
  }
}
