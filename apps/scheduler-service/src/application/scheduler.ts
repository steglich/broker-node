import type { TradingCalendar } from '@broker/calendar';
import type { Clock } from '@broker/clock';
import { BusinessDate } from '@broker/domain-kernel';
import { decide } from '../domain/routines.js';
import type { SchedulerStore, SchedulerTx, StoredExecution } from './ports.js';

export class RoutineNotFailedError extends Error {}

export interface SchedulerOptions {
  store: SchedulerStore;
  calendar: TradingCalendar;
  clock: Clock;
  newId: () => string;
  /** Data do primeiro catch-up quando o banco ainda não tem cursor (padrão: hoje, sem retroativo). */
  startDate?: BusinessDate;
}

/**
 * Casos de uso do agendador. Quem chama garante a liderança (só o líder dispara, RN-ENV-021);
 * a trava do cursor no banco é a segunda linha de defesa contra disparo em dobro.
 */
export class Scheduler {
  constructor(private readonly o: SchedulerOptions) {}

  /** Um passo: dispara o que venceu e está liberado. Devolve o que foi disparado. */
  async step(): Promise<StoredExecution[]> {
    const definitions = await this.o.store.definitions();
    return this.o.store.transaction(async (tx) => {
      const now = this.o.clock.now();
      const cursor = (await tx.lockCursor()) ?? this.o.startDate ?? now.businessDate();
      const executions = await tx.executionsFrom(cursor);
      const decision = decide({ definitions, calendar: this.o.calendar, now, cursor, executions });
      const triggered: StoredExecution[] = [];
      for (const t of decision.trigger) {
        const executionId = this.o.newId();
        const inserted = await tx.insertExecution({
          routineName: t.routineName,
          businessDate: t.businessDate,
          executionId,
          scheduledFor: t.dueAt,
          triggeredAt: now,
          catchUp: t.catchUp,
        });
        if (!inserted) continue;
        await tx.publish({
          type: 'routine.triggered',
          payload: {
            routineName: t.routineName,
            businessDate: t.businessDate.toString(),
            executionId,
            attempt: 1,
            scheduledFor: t.dueAt.toString(),
            catchUp: t.catchUp,
          },
        });
        triggered.push({
          routineName: t.routineName,
          businessDate: t.businessDate,
          status: 'TRIGGERED',
          executionId,
          attempt: 1,
          scheduledFor: t.dueAt,
          triggeredAt: now,
          completedAt: null,
          failureReason: null,
          catchUp: t.catchUp,
        });
      }
      await tx.setCursor(decision.nextCursor);
      return triggered;
    });
  }

  /**
   * `routine.completed` / `routine.failed` do dono da rotina (RN-ROT-002). Com `tx`, roda na
   * transação de quem chama: o consumidor grava inbox, offset e conclusão juntos.
   */
  async finish(
    input: {
      routineName: string;
      businessDate: string;
      executionId: string;
      status: 'COMPLETED' | 'FAILED';
      reason?: string;
    },
    tx?: SchedulerTx,
  ): Promise<'UPDATED' | 'STALE' | 'UNKNOWN'> {
    const run = (t: SchedulerTx) =>
      t.finish({
        routineName: input.routineName,
        businessDate: BusinessDate.parse(input.businessDate),
        executionId: input.executionId,
        status: input.status,
        at: this.o.clock.now(),
        ...(input.reason ? { reason: input.reason } : {}),
      });
    return tx ? run(tx) : this.o.store.transaction(run);
  }

  /** Novo disparo de uma rotina que falhou, com `executionId` novo e `attempt + 1`. */
  async retry(routineName: string, businessDate: string): Promise<StoredExecution> {
    return this.o.store.transaction(async (tx) => {
      const executionId = this.o.newId();
      const retried = await tx.retry({
        routineName,
        businessDate: BusinessDate.parse(businessDate),
        executionId,
        at: this.o.clock.now(),
      });
      if (!retried)
        throw new RoutineNotFailedError(`${routineName}@${businessDate} não está FAILED`);
      await tx.publish({
        type: 'routine.triggered',
        payload: {
          routineName,
          businessDate,
          executionId,
          attempt: retried.attempt,
          scheduledFor: retried.scheduledFor.toString(),
          catchUp: retried.catchUp,
        },
      });
      return retried;
    });
  }
}
