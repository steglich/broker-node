import { TickedClock, type Clock } from '@broker/clock';
import { ClockTickedV1 } from '@broker/contracts/events/clock.ticked/v1';
import { RoutineTriggeredV1 } from '@broker/contracts/events/routine.triggered/v1';
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
import type { DatabaseConfig } from '@broker/persistence';
import {
  createService,
  type Authenticator,
  type BaseConfig,
  type Logger,
} from '@broker/service-kit';
import { sql, type Kysely } from 'kysely';
import { registerHttp } from './adapters/http.js';
import { PostgresAuditStore } from './adapters/postgres-store.js';
import { AuditTrail, DAILY_ROUTINE } from './application/audit-trail.js';
import type { AnchorStorage, CriticalAuditAlert } from './application/ports.js';

export interface AuditServiceDeps {
  config: BaseConfig;
  db: Kysely<unknown>;
  /** Credenciais do banco para o LISTEN do relay. */
  database: DatabaseConfig;
  logger: Logger;
  /** Relógio do ambiente; um `TickedClock` segue os `clock.ticked` do agendador. */
  clock: Clock;
  newId: () => string;
  anchors: AnchorStorage;
  authenticator?: Authenticator;
  /** Sem stream: só banco e HTTP (testes); com stream, relay e consumidores. */
  stream?: StreamSettings;
  /** Contextos cujos tópicos trazem eventos `auditable` e `audit.*` (ex.: identity, bff-backoffice). */
  sourceContexts?: readonly string[];
  /** Avisado a cada alerta crítico, além do log (testes e, adiante, o notification-service). */
  onCriticalAlert?: (alert: CriticalAuditAlert) => void;
}

/**
 * Monta o audit-service (Segurança de aplicação §3, catálogo §20): consumidores da trilha, rotina
 * diária de verificação e âncora, e a consulta restrita.
 */
export async function createAuditService(d: AuditServiceDeps) {
  const environment = d.config.ENVIRONMENT;
  const publisher = new EventPublisher({
    source: d.config.SERVICE_NAME,
    environment,
    clock: d.clock,
    newId: d.newId,
  });
  const store = new PostgresAuditStore(d.db, publisher);
  const trail = new AuditTrail({
    store,
    anchors: d.anchors,
    clock: d.clock,
    newId: d.newId,
    environment,
    serviceName: d.config.SERVICE_NAME,
    onCriticalAlert: (alert) => {
      // RN-AUD-001: quebra da cadeia é alerta crítico.
      d.logger.fatal(
        { event: 'audit.critical_alert', severity: 'critical', ...alert },
        'trilha de auditoria adulterada ou âncora divergente',
      );
      d.onCriticalAlert?.(alert);
    },
  });

  let relay: OutboxRelay | undefined;
  const consumers: EventConsumer[] = [];
  let closeStream: (() => Promise<void>) | undefined;
  if (d.stream) {
    const client = await connectStream(d.stream, d.config.SERVICE_NAME);
    closeStream = () => client.close();
    const superStream = topicName(environment, 'audit');
    // audit.events só leva as respostas da rotina diária: 1 partição basta.
    await ensureSuperStream(client, superStream, { partitions: 1, maxAge: '30D' });
    // O tópico do agendador pode ainda não existir na primeira subida do ambiente; os mesmos
    // parâmetros do dono (1 partição, RN-MSG-B-002), e o agendador consome o nosso.
    await ensureSuperStream(client, topicName(environment, 'scheduler'), {
      partitions: 1,
      maxAge: '30D',
    });
    relay = new OutboxRelay({
      db: d.db,
      listenConfig: d.database,
      producer: await PartitionedProducer.create(
        client,
        superStream,
        `${d.config.SERVICE_NAME}.outbox`,
      ),
      clock: d.clock,
      onError: (err) => d.logger.error({ event: 'outbox.relay_failed', err }, 'falha no relay'),
    });
    const onError = (err: unknown) =>
      d.logger.error({ event: 'consumer.failed', err }, 'falha no consumidor');

    // Trilha: tudo o que o tópico traz passa pelo filtro `auditable`/`audit.*`.
    for (const context of d.sourceContexts ?? []) {
      consumers.push(
        new EventConsumer({
          name: `audit.trail.${context}`,
          environment,
          superStream: topicName(environment, context),
          stream: d.stream,
          db: d.db,
          ordered: false,
          newId: d.newId,
          onError,
          handlers: {
            '*': { handle: async (trx, e) => void (await trail.capture(store.tx(trx), e)) },
          },
        }),
      );
    }

    // Rotina diária e relógio do ambiente, do tópico do agendador.
    consumers.push(
      new EventConsumer({
        name: 'audit.scheduler',
        environment,
        superStream: topicName(environment, 'scheduler'),
        stream: d.stream,
        db: d.db,
        ordered: false,
        newId: d.newId,
        onError,
        handlers: {
          'routine.triggered': {
            definition: RoutineTriggeredV1,
            handle: async (_trx, e) => {
              const p = e.payload as {
                routineName: string;
                businessDate: string;
                executionId: string;
              };
              if (p.routineName !== DAILY_ROUTINE) return;
              const outcome = await trail.runDaily(p);
              d.logger.info({ event: 'audit.daily_routine', outcome, ...p }, 'rotina diária');
            },
          },
          'clock.ticked': {
            definition: ClockTickedV1,
            handle: async (_trx, e) => {
              if (d.clock instanceof TickedClock)
                d.clock.apply(e.payload as { virtualNow: string });
            },
          },
        },
      }),
    );
  }

  const service = createService({
    config: d.config,
    clock: d.clock,
    logger: d.logger,
    readiness: { database: () => sql`SELECT 1`.execute(d.db) },
    ...(d.authenticator ? { authenticator: d.authenticator } : {}),
  });
  registerHttp(service, { trail });

  return {
    service,
    trail,
    store,
    consumers,
    async start() {
      await relay?.start();
      for (const c of consumers) await c.start();
    },
    async stop() {
      for (const c of consumers) await c.stop();
      await relay?.stop();
      await closeStream?.();
    },
  };
}
