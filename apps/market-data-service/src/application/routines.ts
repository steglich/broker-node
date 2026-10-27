import { BusinessDate } from '@broker/domain-kernel';
import type { MarketDataDeps } from './context.js';
import type { MarketDataTx } from './ports.js';

/** Rotinas do agendador que o market-data executa (Pregão §8). */
export const MARKET_DATA_ROUTINES = {
  /** Fim do pregão: a referência passa a ser o fechamento, sem ruído (RN-SYN-001). */
  dailyClose: 'daily_close',
  /** 18:00: leitura pós-fechamento e candle diário externo (RN-BRP-052/062). */
  closeSnapshot: 'brapi_close_snapshot',
} as const;

const OWNED: ReadonlySet<string> = new Set(Object.values(MARKET_DATA_ROUTINES));

export type RoutineHandler = (businessDate: BusinessDate) => Promise<Record<string, unknown>>;

/**
 * Rotinas como trabalho durável (`provider_job`): o consumidor de `routine.triggered` só grava o
 * pedido na própria transação (pode estar numa instância que não é a líder da fila da brapi) e o
 * líder executa e responde `routine.completed`/`routine.failed`. Idempotente por
 * `(routineName, businessDate)`: um novo disparo (retentativa do agendador) troca o `executionId`.
 */
export class RoutineJobs {
  constructor(
    private readonly d: MarketDataDeps,
    private readonly handlers: Record<string, RoutineHandler>,
  ) {}

  async onTriggered(
    tx: MarketDataTx,
    p: { routineName: string; businessDate: string; executionId: string },
  ): Promise<void> {
    if (!OWNED.has(p.routineName)) return;
    await tx.enqueueJob({
      id: this.d.newId(),
      routineName: p.routineName,
      businessDate: BusinessDate.parse(p.businessDate),
      executionId: p.executionId,
      status: 'PENDING',
    });
  }

  /** Executa os pendentes (só no líder). */
  async runPending(): Promise<number> {
    const jobs = await this.d.store.transaction((tx) => tx.pendingJobs(10));
    for (const job of jobs) {
      const base = {
        routineName: job.routineName,
        businessDate: job.businessDate.toString(),
        executionId: job.executionId,
      };
      const handler = this.handlers[job.routineName];
      try {
        const stats = handler ? await handler(job.businessDate) : {};
        await this.d.store.transaction(async (tx) => {
          await tx.finishJob(job.id, 'DONE');
          await tx.publish(
            { type: 'routine.completed', payload: { ...base, stats } },
            job.routineName,
          );
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.d.logger.error(
          { event: 'market_data.routine_failed', err, routine: job.routineName },
          'rotina falhou',
        );
        await this.d.store.transaction(async (tx) => {
          await tx.finishJob(job.id, 'FAILED');
          await tx.publish(
            { type: 'routine.failed', payload: { ...base, reason } },
            job.routineName,
          );
        });
      }
    }
    return jobs.length;
  }
}
