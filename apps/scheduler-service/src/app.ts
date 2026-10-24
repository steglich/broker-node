import type { TradingCalendar } from '@broker/calendar';
import { RoutineCompletedV1 } from '@broker/contracts/events/routine.completed/v1';
import { RoutineFailedV1 } from '@broker/contracts/events/routine.failed/v1';
import type { BusinessDate, Instant } from '@broker/domain-kernel';
import {
  connectStream,
  ensureSuperStream,
  EventConsumer,
  EventPublisher,
  OutboxRelay,
  PartitionedProducer,
  topicName,
  type StreamSettings,
} from '@broker/messaging';
import { LeaderElector, type DatabaseConfig } from '@broker/persistence';
import { createService, type BaseConfig, type Logger } from '@broker/service-kit';
import { sql, type Kysely } from 'kysely';
import { registerHttp } from './adapters/http.js';
import { PostgresSchedulerStore } from './adapters/postgres-store.js';
import { EnvironmentClock } from './application/environment-clock.js';
import type { ClockMode } from './application/ports.js';
import { SchedulerRunner } from './application/runner.js';
import { Scheduler } from './application/scheduler.js';

export interface SchedulerServiceDeps {
  config: BaseConfig;
  db: Kysely<unknown>;
  /** Credenciais do banco para a conexão da eleição de líder e o LISTEN do relay. */
  database: DatabaseConfig;
  logger: Logger;
  calendar: TradingCalendar;
  newId: () => string;
  clock: { mode: ClockMode; start?: Instant; speedFactor?: number; wall?: () => number };
  startDate?: BusinessDate;
  /** Sem stream: só banco (testes de unidade de trabalho); com stream, relay e consumidores. */
  stream?: StreamSettings;
  /** Contextos cujos tópicos trazem `routine.completed`/`routine.failed` (ex.: clearing, session). */
  resultContexts?: readonly string[];
  /** Intervalo do laço do líder; padrão 1 s, ou menos no modo acelerado (1 tick por minuto virtual). */
  loopIntervalMs?: number;
  leaderHeartbeatMs?: number;
  adminApi: boolean;
}

/**
 * Monta o scheduler-service (D14, D15, RN-ROT-001..003). Só o líder dá passos, publica o relógio e
 * roda o relay da outbox; as réplicas ficam em espera e servem as leituras.
 */
export async function createSchedulerService(d: SchedulerServiceDeps) {
  const environment = d.config.ENVIRONMENT;
  // O publisher precisa do relógio, e o relógio é carregado pelo store, que precisa do publisher.
  const clockRef: { current?: EnvironmentClock } = {};
  const publisher = new EventPublisher({
    source: d.config.SERVICE_NAME,
    environment,
    // O occurredAt dos eventos é o tempo do ambiente (RN-CLK-004).
    clock: {
      mode: d.clock.mode,
      now: () => clockRef.current!.now(),
      businessDate: () => clockRef.current!.businessDate(),
    },
    newId: d.newId,
  });
  const store = new PostgresSchedulerStore(d.db, publisher);
  const clock = await EnvironmentClock.load(store, d.clock, d.clock.wall);
  clockRef.current = clock;
  const scheduler = new Scheduler({
    store,
    calendar: d.calendar,
    clock,
    newId: d.newId,
    ...(d.startDate ? { startDate: d.startDate } : {}),
  });

  let leader = false;
  const isLeader = () => leader;
  const runner = new SchedulerRunner({
    scheduler,
    clock,
    store,
    calendar: d.calendar,
    isLeader,
    onError: (err) =>
      d.logger.error({ event: 'scheduler.step_failed', err }, 'falha no passo do agendador'),
  });

  // Relay da outbox (só no líder) e consumidores dos resultados das rotinas.
  let relay: OutboxRelay | undefined;
  const consumers: EventConsumer[] = [];
  let closeStream: (() => Promise<void>) | undefined;
  if (d.stream) {
    const client = await connectStream(d.stream, d.config.SERVICE_NAME);
    closeStream = () => client.close();
    const superStream = topicName(environment, 'scheduler');
    // scheduler.events: 1 partição (RN-MSG-B-002), ordem total de rotinas e ticks.
    await ensureSuperStream(client, superStream, { partitions: 1, maxAge: '30D' });
    relay = new OutboxRelay({
      db: d.db,
      listenConfig: d.database,
      producer: await PartitionedProducer.create(
        client,
        superStream,
        `${d.config.SERVICE_NAME}.outbox`,
      ),
      clock,
      onError: (err) => d.logger.error({ event: 'outbox.relay_failed', err }, 'falha no relay'),
    });
    for (const context of d.resultContexts ?? []) {
      const handle = async (trx: Kysely<unknown>, payload: Parameters<Scheduler['finish']>[0]) => {
        const outcome = await scheduler.finish(payload, store.tx(trx));
        if (outcome !== 'UPDATED') {
          d.logger.warn(
            { event: 'routine.result_ignored', outcome, ...payload },
            'resultado de rotina ignorado',
          );
        }
      };
      const consumer = new EventConsumer({
        name: `scheduler.routine-results.${context}`,
        environment,
        superStream: topicName(environment, context),
        stream: d.stream,
        db: d.db,
        ordered: false,
        newId: d.newId,
        onError: (err) => d.logger.error({ event: 'consumer.failed', err }, 'falha no consumidor'),
        handlers: {
          'routine.completed': {
            definition: RoutineCompletedV1,
            handle: async (trx, e) => {
              const p = e.payload as {
                routineName: string;
                businessDate: string;
                executionId: string;
              };
              await handle(trx, { ...p, status: 'COMPLETED' });
              // Depois do commit: libera as dependentes sem esperar o próximo ciclo (RN-ROT-002).
              setImmediate(() => void runner.tick().catch(() => undefined));
            },
          },
          'routine.failed': {
            definition: RoutineFailedV1,
            handle: async (trx, e) => {
              const p = e.payload as {
                routineName: string;
                businessDate: string;
                executionId: string;
                reason: string;
              };
              await handle(trx, { ...p, status: 'FAILED' });
            },
          },
        },
      });
      consumers.push(consumer);
    }
  }

  const elector = new LeaderElector({
    database: d.database,
    name: 'scheduler',
    ...(d.leaderHeartbeatMs ? { heartbeatMs: d.leaderHeartbeatMs } : {}),
    onElected: () => {
      void (async () => {
        // Retoma o relógio do líder anterior antes do primeiro passo.
        await runner.elected();
        await relay?.start();
        leader = true;
        d.logger.info({ event: 'scheduler.elected' }, 'agendador líder');
        await runner.tick();
      })().catch((err: unknown) =>
        d.logger.error({ event: 'scheduler.election_failed', err }, 'falha ao assumir'),
      );
    },
    onRevoked: (reason) => {
      leader = false;
      void relay?.stop();
      d.logger.warn({ event: 'scheduler.revoked', reason }, 'agendador deixou de ser líder');
    },
    onError: (err) => d.logger.error({ event: 'scheduler.leader_error', err }, 'falha na eleição'),
  });

  const service = createService({
    config: d.config,
    clock,
    logger: d.logger,
    readiness: { database: () => sql`SELECT 1`.execute(d.db) },
  });
  registerHttp(service, { scheduler, runner, clock, store, isLeader, adminEnabled: d.adminApi });

  const interval =
    d.loopIntervalMs ??
    (clock.mode === 'ACCELERATED' ? Math.min(1000, Math.floor(60_000 / clock.speedFactor)) : 1000);

  return {
    service,
    scheduler,
    runner,
    clock,
    store,
    elector,
    isLeader,
    async start() {
      for (const c of consumers) await c.start();
      await elector.start();
      runner.start(interval);
    },
    async stop() {
      await runner.stop();
      await elector.stop();
      leader = false;
      for (const c of consumers) await c.stop();
      await relay?.stop();
      await closeStream?.();
    },
  };
}
