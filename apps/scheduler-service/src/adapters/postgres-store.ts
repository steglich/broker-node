import { ClockTickedV1 } from '@broker/contracts/events/clock.ticked/v1';
import { RoutineTriggeredV1 } from '@broker/contracts/events/routine.triggered/v1';
import { BusinessDate, Instant } from '@broker/domain-kernel';
import type { EventPublisher } from '@broker/messaging';
import { inTransaction } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type {
  SchedulerStore,
  SchedulerTx,
  StoredClock,
  StoredExecution,
} from '../application/ports.js';
import type { RoutineDefinition } from '../domain/routines.js';

interface ExecutionRow {
  routine_name: string;
  business_date: string;
  status: StoredExecution['status'];
  execution_id: string;
  attempt: number;
  scheduled_for: Date;
  triggered_at: Date;
  completed_at: Date | null;
  failure_reason: string | null;
  catch_up: boolean;
}

const instant = (d: Date) => Instant.ofEpochMillis(d.getTime());
const toExecution = (r: ExecutionRow): StoredExecution => ({
  routineName: r.routine_name,
  businessDate: BusinessDate.parse(r.business_date),
  status: r.status,
  executionId: r.execution_id,
  attempt: r.attempt,
  scheduledFor: instant(r.scheduled_for),
  triggeredAt: instant(r.triggered_at),
  completedAt: r.completed_at ? instant(r.completed_at) : null,
  failureReason: r.failure_reason,
  catchUp: r.catch_up,
});

// `business_date::text`: a data sem fuso, como está no banco (o driver converteria para Date local).
const EXECUTION_COLUMNS = sql`routine_name, business_date::text AS business_date, status, execution_id, attempt,
  scheduled_for, triggered_at, completed_at, failure_reason, catch_up`;

const ACTOR = { type: 'SYSTEM' as const, id: 'scheduler-service' };

/** Adaptador do banco do agendador; os eventos vão para a outbox na mesma transação (ADR-0008). */
export class PostgresSchedulerStore implements SchedulerStore {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly publisher: EventPublisher,
  ) {}

  async definitions(): Promise<RoutineDefinition[]> {
    const { rows } = await sql<{
      name: string;
      owner: string;
      schedule: RoutineDefinition['schedule'];
      days: RoutineDefinition['days'];
      depends_on: string[];
      enabled: boolean;
    }>`SELECT * FROM routine_definition ORDER BY name`.execute(this.db);
    return rows.map((r) => ({
      name: r.name,
      owner: r.owner,
      schedule: r.schedule,
      days: r.days,
      dependsOn: r.depends_on,
      enabled: r.enabled,
    }));
  }

  async executions(filter: { from: BusinessDate; to: BusinessDate }): Promise<StoredExecution[]> {
    const { rows } = await sql<ExecutionRow>`
      SELECT ${EXECUTION_COLUMNS} FROM routine_execution
      WHERE business_date BETWEEN ${filter.from.toString()} AND ${filter.to.toString()}
      ORDER BY business_date, scheduled_for, routine_name
      LIMIT 2000`.execute(this.db);
    return rows.map(toExecution);
  }

  transaction<T>(fn: (tx: SchedulerTx) => Promise<T>): Promise<T> {
    return inTransaction(this.db, (trx) => fn(this.tx(trx)));
  }

  /** Unidade de trabalho sobre uma transação já aberta (ex.: a do consumidor, com a inbox). */
  tx(trx: Kysely<unknown>): SchedulerTx {
    const publisher = this.publisher;
    return {
      async lockCursor() {
        const row = (
          await sql<{ cursor: string | null }>`
          SELECT cursor::text AS cursor FROM scheduler_state WHERE id = 1 FOR UPDATE`.execute(trx)
        ).rows[0];
        return row?.cursor ? BusinessDate.parse(row.cursor) : null;
      },
      async setCursor(date) {
        await sql`UPDATE scheduler_state SET cursor = ${date.toString()} WHERE id = 1`.execute(trx);
      },
      async executionsFrom(date) {
        const { rows } = await sql<ExecutionRow>`
          SELECT ${EXECUTION_COLUMNS} FROM routine_execution WHERE business_date >= ${date.toString()}`.execute(
          trx,
        );
        return rows.map(toExecution);
      },
      async insertExecution(e) {
        const res = await sql`
          INSERT INTO routine_execution (routine_name, business_date, status, execution_id, scheduled_for, triggered_at, catch_up)
          VALUES (${e.routineName}, ${e.businessDate.toString()}, 'TRIGGERED', ${e.executionId},
                  ${e.scheduledFor.toString()}, ${e.triggeredAt.toString()}, ${e.catchUp})
          ON CONFLICT (routine_name, business_date) DO NOTHING`.execute(trx);
        return Number(res.numAffectedRows ?? 0) === 1;
      },
      async finish(e) {
        const current = (
          await sql<{ execution_id: string; status: string }>`
          SELECT execution_id, status FROM routine_execution
          WHERE routine_name = ${e.routineName} AND business_date = ${e.businessDate.toString()} FOR UPDATE`.execute(
            trx,
          )
        ).rows[0];
        if (!current) return 'UNKNOWN';
        // Resposta de uma tentativa antiga (já houve outro disparo depois dela): ignorada.
        if (current.execution_id !== e.executionId) return 'STALE';
        await sql`
          UPDATE routine_execution SET status = ${e.status}, completed_at = ${e.status === 'COMPLETED' ? e.at.toString() : null},
                 failure_reason = ${e.reason ?? null}
          WHERE routine_name = ${e.routineName} AND business_date = ${e.businessDate.toString()}`.execute(
          trx,
        );
        return 'UPDATED';
      },
      async retry(e) {
        const { rows } = await sql<ExecutionRow>`
          UPDATE routine_execution SET status = 'TRIGGERED', execution_id = ${e.executionId}, attempt = attempt + 1,
                 triggered_at = ${e.at.toString()}, failure_reason = NULL, completed_at = NULL
          WHERE routine_name = ${e.routineName} AND business_date = ${e.businessDate.toString()} AND status = 'FAILED'
          RETURNING ${EXECUTION_COLUMNS}`.execute(trx);
        return rows[0] ? toExecution(rows[0]) : null;
      },
      async loadClock() {
        const row = (
          await sql<{ mode: StoredClock['mode']; virtual_now: Date; speed_factor: number }>`
          SELECT mode, virtual_now, speed_factor FROM clock_state WHERE id = 1`.execute(trx)
        ).rows[0];
        return row
          ? { mode: row.mode, virtualNow: instant(row.virtual_now), speedFactor: row.speed_factor }
          : null;
      },
      async saveClock(c) {
        await sql`
          INSERT INTO clock_state (id, mode, virtual_now, speed_factor) VALUES (1, ${c.mode}, ${c.virtualNow.toString()}, ${c.speedFactor})
          ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode, virtual_now = EXCLUDED.virtual_now, speed_factor = EXCLUDED.speed_factor`.execute(
          trx,
        );
      },
      async publish(event) {
        if (event.type === 'routine.triggered') {
          await publisher.publish(trx, RoutineTriggeredV1, event.payload, {
            // scheduler.events é particionado por routine_name (RN-MSG-B-002).
            partitionKey: event.payload.routineName,
            aggregateType: 'routine_execution',
            aggregateId: `${event.payload.routineName}@${event.payload.businessDate}`,
            actor: ACTOR,
          });
        } else {
          await publisher.publish(trx, ClockTickedV1, event.payload, {
            partitionKey: 'clock',
            aggregateType: 'clock',
            aggregateId: 'environment',
            actor: ACTOR,
          });
        }
      },
    };
  }
}
