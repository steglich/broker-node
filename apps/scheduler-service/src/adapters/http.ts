import { schedulerServiceHttp } from '@broker/contracts/http/scheduler-service';
import { BusinessDate, Instant } from '@broker/domain-kernel';
import { conflict, HttpError, notFound, validationError, type Service } from '@broker/service-kit';
import { ClockModeError, type EnvironmentClock } from '../application/environment-clock.js';
import type { SchedulerStore, StoredExecution } from '../application/ports.js';
import { NotLeaderError, type SchedulerRunner } from '../application/runner.js';
import { RoutineNotFailedError, type Scheduler } from '../application/scheduler.js';

const r = schedulerServiceHttp.routes;

const executionView = (e: StoredExecution) => ({
  routineName: e.routineName,
  businessDate: e.businessDate.toString(),
  status: e.status,
  executionId: e.executionId,
  attempt: e.attempt,
  scheduledFor: e.scheduledFor.toString(),
  triggeredAt: e.triggeredAt.toString(),
  completedAt: e.completedAt?.toString() ?? null,
  failureReason: e.failureReason,
  catchUp: e.catchUp,
});

export interface HttpDeps {
  scheduler: Scheduler;
  runner: SchedulerRunner;
  clock: EnvironmentClock;
  store: SchedulerStore;
  isLeader: () => boolean;
  /** Rotas que mudam estado (relógio, re-disparo, resultado manual). */
  adminEnabled: boolean;
}

export function registerHttp(service: Service, d: HttpDeps): void {
  const clockView = () => ({
    mode: d.clock.mode,
    now: d.clock.now().toString(),
    businessDate: d.clock.businessDate().toString(),
    speedFactor: d.clock.speedFactor,
    leader: d.isLeader(),
  });

  service.route({
    method: 'get',
    path: '/v1/clock',
    auth: 'public',
    handler: async () => ({ body: clockView() }),
  });
  service.route({
    method: 'get',
    path: '/v1/routines',
    auth: 'public',
    handler: async () => ({ body: { routines: await d.store.definitions() } }),
  });
  service.route({
    method: 'get',
    path: '/v1/routine-executions',
    auth: 'public',
    validate: { query: r.listExecutions.query },
    handler: async (req) => {
      const from = BusinessDate.parse(req.query.from);
      const to = BusinessDate.parse(req.query.to);
      // Consulta limitada (RN-BE-070): no máximo 1 ano por vez.
      if (to.isBefore(from) || to.epochDay - from.epochDay > 366) {
        throw validationError([
          { field: 'to', code: 'INVALID_RANGE', message: 'Use um período de até 1 ano.' },
        ]);
      }
      return { body: { executions: (await d.store.executions({ from, to })).map(executionView) } };
    },
  });

  if (!d.adminEnabled) return;

  service.route({
    method: 'post',
    path: '/v1/clock/advance',
    auth: 'public',
    idempotent: false,
    validate: { body: r.advanceClock.body },
    handler: async (req) => {
      try {
        await d.runner.advanceTo(Instant.parse(req.body.to));
      } catch (err) {
        if (err instanceof NotLeaderError) throw new HttpError(503, 'NOT_LEADER', err.message);
        if (err instanceof ClockModeError) {
          throw conflict(
            d.clock.mode === 'VIRTUAL' ? 'CLOCK_CANNOT_GO_BACK' : 'CLOCK_MODE_NOT_VIRTUAL',
            err.message,
          );
        }
        throw err;
      }
      return { body: clockView() };
    },
  });
  service.route({
    method: 'post',
    path: '/v1/routine-executions/:routineName/:businessDate/retry',
    auth: 'public',
    idempotent: false,
    validate: { params: r.retryExecution.params },
    handler: async (req) => {
      try {
        return {
          status: 202,
          body: executionView(
            await d.scheduler.retry(req.params.routineName, req.params.businessDate),
          ),
        };
      } catch (err) {
        if (err instanceof RoutineNotFailedError) throw conflict('ROUTINE_NOT_FAILED', err.message);
        throw err;
      }
    },
  });
  service.route({
    method: 'post',
    path: '/v1/routine-executions/:routineName/:businessDate/result',
    auth: 'public',
    idempotent: false,
    validate: { params: r.reportResult.params, body: r.reportResult.body },
    handler: async (req) => {
      let outcome = 'UPDATED';
      await d.runner.afterFinish(async () => {
        outcome = await d.scheduler.finish({
          routineName: req.params.routineName,
          businessDate: req.params.businessDate,
          executionId: req.body.executionId,
          status: req.body.status,
          ...(req.body.reason ? { reason: req.body.reason } : {}),
        });
      });
      if (outcome === 'UNKNOWN') throw notFound('Execução inexistente.');
      if (outcome === 'STALE')
        throw conflict('EXECUTION_STALE', 'O executionId é de uma tentativa anterior.');
      return { status: 204 };
    },
  });
}
