import { TickedClock, type Clock } from '@broker/clock';
import { AccountStatusChangedV1 } from '@broker/contracts/events/account.status_changed/v1';
import { ClockTickedV1 } from '@broker/contracts/events/clock.ticked/v1';
import { DepositCreditedV1 } from '@broker/contracts/events/deposit.credited/v1';
import { DepositRefundedV1 } from '@broker/contracts/events/deposit.refunded/v1';
import { IdentityNewDeviceDetectedV1 } from '@broker/contracts/events/identity.new_device_detected/v1';
import { IdentityPasswordChangedV1 } from '@broker/contracts/events/identity.password_changed/v1';
import { IdentityTradingSignatureChangedV1 } from '@broker/contracts/events/identity.trading_signature_changed/v1';
import { LedgerNegativeBalanceDetectedV1 } from '@broker/contracts/events/ledger.negative_balance_detected/v1';
import { OnboardingApprovedV1 } from '@broker/contracts/events/onboarding.approved/v1';
import { OnboardingRejectedV1 } from '@broker/contracts/events/onboarding.rejected/v1';
import { OnboardingSubmittedV1 } from '@broker/contracts/events/onboarding.submitted/v1';
import { SuitabilityExpiredV1 } from '@broker/contracts/events/suitability.expired/v1';
import { SuitabilityExpiringV1 } from '@broker/contracts/events/suitability.expiring/v1';
import { WithdrawalCompletedV1 } from '@broker/contracts/events/withdrawal.completed/v1';
import { WithdrawalFailedV1 } from '@broker/contracts/events/withdrawal.failed/v1';
import { WithdrawalRejectedV1 } from '@broker/contracts/events/withdrawal.rejected/v1';
import {
  connectStream,
  ensureSuperStream,
  EventConsumer,
  EventPublisher,
  OutboxRelay,
  PartitionedProducer,
  topicName,
  type EventDefinition,
  type EventHandler,
  type StreamSettings,
} from '@broker/messaging';
import type { DatabaseConfig } from '@broker/persistence';
import {
  createService,
  IdempotencyStore,
  type Authenticator,
  type BaseConfig,
} from '@broker/service-kit';
import { sql, type Kysely } from 'kysely';
import { registerHttp } from './adapters/http.js';
import { PostgresNotificationStore } from './adapters/postgres-store.js';
import { NotificationCenter, Preferences, PushDevices } from './application/center.js';
import type { NotificationDeps } from './application/context.js';
import { Dispatcher } from './application/dispatcher.js';
import { Notifier } from './application/notifier.js';
import { SOURCES } from './application/sources.js';

/** Eventos de origem da Fase 1 por tópico (Notificações §3; as ordens chegam na Fase 2). */
const SOURCE_TOPICS: Record<string, Record<string, EventDefinition>> = {
  ledger: {
    'deposit.credited': DepositCreditedV1,
    'deposit.refunded': DepositRefundedV1,
    'withdrawal.completed': WithdrawalCompletedV1,
    'withdrawal.failed': WithdrawalFailedV1,
    'withdrawal.rejected': WithdrawalRejectedV1,
    'ledger.negative_balance_detected': LedgerNegativeBalanceDetectedV1,
  },
  customer: {
    'account.status_changed': AccountStatusChangedV1,
    'suitability.expiring': SuitabilityExpiringV1,
    'suitability.expired': SuitabilityExpiredV1,
    'onboarding.submitted': OnboardingSubmittedV1,
    'onboarding.approved': OnboardingApprovedV1,
    'onboarding.rejected': OnboardingRejectedV1,
  },
  identity: {
    'identity.new_device_detected': IdentityNewDeviceDetectedV1,
    'identity.password_changed': IdentityPasswordChangedV1,
    'identity.trading_signature_changed': IdentityTradingSignatureChangedV1,
  },
};

const PURGE_EVERY_MS = 10 * 60_000;

export interface NotificationServiceDeps extends Omit<NotificationDeps, 'store'> {
  config: BaseConfig;
  db: Kysely<unknown>;
  database: DatabaseConfig;
  clock: Clock;
  authenticator: Authenticator;
  stream?: StreamSettings;
  /** Intervalo do laço de entrega (padrão 1 s). */
  workerIntervalMs?: number;
}

/** Monta o notification-service (catálogo de serviços §17). */
export async function createNotificationService(d: NotificationServiceDeps) {
  const environment = d.config.ENVIRONMENT;
  const publisher = new EventPublisher({
    source: d.config.SERVICE_NAME,
    environment,
    clock: d.clock,
    newId: d.newId,
  });
  const store = new PostgresNotificationStore(d.db, publisher);
  const deps: NotificationDeps = { ...d, store };
  const notifier = new Notifier(deps);
  const dispatcher = new Dispatcher(deps);
  const center = new NotificationCenter(deps);
  const preferences = new Preferences(deps);
  const devices = new PushDevices(deps);

  let lastPurge = -Infinity;
  /** Uma rodada: agrupadas que fecharam, entregas vencidas e, de tempos em tempos, a retenção. */
  const work = async () => {
    await dispatcher.releaseGroups();
    while ((await dispatcher.runDue()) > 0) {
      /* esvazia o que venceu */
    }
    const now = d.clock.now().epochMillis;
    if (now - lastPurge >= PURGE_EVERY_MS) {
      await dispatcher.purge();
      lastPurge = now;
    }
  };

  /** Handler de um evento de origem: mapeia e notifica na transação do consumidor (com a inbox). */
  const handler = (type: string, definition: EventDefinition): EventHandler => ({
    definition,
    handle: async (trx, e) => {
      const source = SOURCES[type]!({
        eventId: e.eventId,
        occurredAt: e.occurredAt,
        payload: e.payload,
      });
      if (source) await notifier.notify(store.tx(trx), source);
    },
  });

  let relay: OutboxRelay | undefined;
  const consumers: EventConsumer[] = [];
  let closeStream: (() => Promise<void>) | undefined;
  if (d.stream) {
    const client = await connectStream(d.stream, d.config.SERVICE_NAME);
    closeStream = () => client.close();
    const superStream = topicName(environment, 'notification');
    // notification.events: 7 dias (Mensageria, Diretrizes §2).
    await ensureSuperStream(client, superStream, { maxAge: '7D' });
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
    const base = { environment, stream: d.stream, db: d.db, newId: d.newId, onError };

    for (const [context, events] of Object.entries(SOURCE_TOPICS)) {
      const topic = topicName(environment, context);
      await ensureSuperStream(client, topic, { maxAge: context === 'ledger' ? '90D' : '30D' });
      consumers.push(
        new EventConsumer({
          ...base,
          // Notificações não dependem de ordem: a DLQ não bloqueia a chave (RN-MSG-B-035).
          ordered: false,
          name: `notification.${context}`,
          superStream: topic,
          // Um consumidor novo não reenvia o histórico: só o que chegar depois dele.
          startFrom: 'next',
          handlers: Object.fromEntries(
            Object.entries(events).map(([type, def]) => [type, handler(type, def)]),
          ),
        }),
      );
    }
    const schedulerStream = topicName(environment, 'scheduler');
    await ensureSuperStream(client, schedulerStream, { partitions: 1, maxAge: '30D' });
    consumers.push(
      new EventConsumer({
        ...base,
        ordered: false,
        name: 'notification.scheduler',
        superStream: schedulerStream,
        handlers: {
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
    authenticator: d.authenticator,
    idempotency: new IdempotencyStore({ db: d.db }),
    readiness: { database: () => sql`SELECT 1`.execute(d.db) },
  });
  registerHttp(service, { center, preferences, devices });

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  return {
    service,
    store,
    notifier,
    dispatcher,
    center,
    preferences,
    devices,
    work,
    async start() {
      await relay?.start();
      for (const c of consumers) await c.start();
      timer = setInterval(() => {
        if (running) return;
        running = true;
        void work()
          .catch((err: unknown) =>
            d.logger.error(
              { event: 'notification.worker_failed', err },
              'falha no laço de entrega',
            ),
          )
          .finally(() => (running = false));
      }, d.workerIntervalMs ?? 1000);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      for (const c of consumers) await c.stop();
      await relay?.stop();
      await closeStream?.();
    },
  };
}
