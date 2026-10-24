import { TickedClock, type Clock } from '@broker/clock';
import { ClockTickedV1 } from '@broker/contracts/events/clock.ticked/v1';
import { IdentityUserRegisteredV1 } from '@broker/contracts/events/identity.user_registered/v1';
import { LedgerNegativeBalanceClearedV1 } from '@broker/contracts/events/ledger.negative_balance_cleared/v1';
import { LedgerNegativeBalanceDetectedV1 } from '@broker/contracts/events/ledger.negative_balance_detected/v1';
import { RoutineCompletedV1 } from '@broker/contracts/events/routine.completed/v1';
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
  IdempotencyStore,
  SagaOrchestrator,
  type Authenticator,
  type BaseConfig,
  type Logger,
  type SignatureVerifier,
} from '@broker/service-kit';
import { sql, type Kysely } from 'kysely';
import { registerHttp } from './adapters/http.js';
import { PostgresCustomerStore } from './adapters/postgres-store.js';
import { Accounts } from './application/accounts.js';
import type { CustomerDeps } from './application/context.js';
import { Onboarding } from './application/onboarding.js';
import { AccountOpening, OPENING_SAGA, type OpeningData } from './application/opening.js';
import { SuitabilityAndTerms } from './application/suitability-terms.js';

/** Rotina diária do agendador: expirações do onboarding, do suitability e do cadastro. */
export const DAILY_ROUTINE = 'customer_daily';

export interface CustomerServiceDeps extends Omit<CustomerDeps, 'store'> {
  config: BaseConfig;
  db: Kysely<unknown>;
  database: DatabaseConfig;
  logger: Logger;
  clock: Clock;
  authenticator: Authenticator;
  signatureVerifier: SignatureVerifier;
  kycWebhookSecret: string;
  stream?: StreamSettings;
  /** Consome `ledger.negative_balance_*` (liga quando o ledger-service publicar). */
  consumeLedgerEvents?: boolean;
  /** Intervalo da retomada das sagas de abertura (padrão 10 s). */
  sagaResumeMs?: number;
}

/** Monta o customer-service (catálogo de serviços §2). */
export async function createCustomerService(d: CustomerServiceDeps) {
  const environment = d.config.ENVIRONMENT;
  const publisher = new EventPublisher({
    source: d.config.SERVICE_NAME,
    environment,
    clock: d.clock,
    newId: d.newId,
  });
  const store = new PostgresCustomerStore(d.db, publisher);
  const deps: CustomerDeps = { ...d, store };
  const opening = new AccountOpening(deps);
  const sagas = new SagaOrchestrator({
    db: d.db,
    newId: d.newId,
    logger: d.logger,
    definitions: [
      {
        type: OPENING_SAGA,
        steps: [
          {
            name: 'create_customer_and_account',
            timeoutMs: 10_000,
            idempotent: true,
            maxAttempts: 5,
            run: (data: OpeningData) => opening.createCustomerAndAccount(data),
          },
          {
            name: 'open_bank_account',
            timeoutMs: 15_000,
            idempotent: true,
            maxAttempts: 10,
            run: (data: OpeningData) => opening.openBankAccount(data),
          },
        ],
      },
    ] as never,
  });
  const startOpening = async (applicationId: string) => {
    // Falha aqui não perde a abertura: a retomada periódica acha a solicitação aprovada sem cliente.
    await sagas
      .start<OpeningData>(OPENING_SAGA, { applicationId })
      .catch((err: unknown) =>
        d.logger.error(
          { event: 'opening.start_failed', applicationId, err },
          'falha ao iniciar a abertura',
        ),
      );
  };
  const onboarding = new Onboarding(deps, startOpening);
  const suitability = new SuitabilityAndTerms(deps, onboarding);
  const accounts = new Accounts(deps, suitability);

  /** Retoma sagas interrompidas e aprovações que não chegaram a iniciar a saga (RN-PAD-030). */
  const resumeOpenings = async () => {
    await sagas.resumePending();
    for (const applicationId of await store.approvedWithoutOpening())
      await startOpening(applicationId);
  };

  /** Rotina diária: RN-ONB-002, RN-SUI-012 e RN-CAD-003. */
  const runDaily = async () => {
    const now = d.clock.now();
    const expired = await onboarding.expireIdle(now);
    const suit = await suitability.notifyExpirations(now.businessDate());
    const restricted = await accounts.restrictExpiredRegistrations(now.businessDate());
    return { expiredApplications: expired, ...suit, restrictedRegistrations: restricted };
  };

  let relay: OutboxRelay | undefined;
  const consumers: EventConsumer[] = [];
  let closeStream: (() => Promise<void>) | undefined;
  if (d.stream) {
    const client = await connectStream(d.stream, d.config.SERVICE_NAME);
    closeStream = () => client.close();
    const superStream = topicName(environment, 'customer');
    await ensureSuperStream(client, superStream, { maxAge: '30D' });
    // Tópicos consumidos cujos donos podem subir depois, com os parâmetros dos donos: o agendador
    // (1 partição) e o identity, que por sua vez consome o nosso.
    await ensureSuperStream(client, topicName(environment, 'scheduler'), {
      partitions: 1,
      maxAge: '30D',
    });
    await ensureSuperStream(client, topicName(environment, 'identity'), { maxAge: '30D' });
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
    const base = {
      environment,
      stream: d.stream,
      db: d.db,
      ordered: false,
      newId: d.newId,
      onError,
    };

    consumers.push(
      new EventConsumer({
        ...base,
        name: 'customer.identity',
        superStream: topicName(environment, 'identity'),
        handlers: {
          // Login criado no realm de clientes: a solicitação nasce `STARTED` (Fluxos §1).
          'identity.user_registered': {
            definition: IdentityUserRegisteredV1,
            handle: async (trx, e) => {
              const p = e.payload as { userId: string; realm: string };
              if (p.realm === 'customers') await onboarding.ensureStarted(store.tx(trx), p.userId);
            },
          },
        },
      }),
    );
    consumers.push(
      new EventConsumer({
        ...base,
        name: 'customer.scheduler',
        superStream: topicName(environment, 'scheduler'),
        handlers: {
          'routine.triggered': {
            definition: RoutineTriggeredV1,
            handle: async (trx, e) => {
              const p = e.payload as {
                routineName: string;
                businessDate: string;
                executionId: string;
              };
              if (p.routineName !== DAILY_ROUTINE) return;
              const stats = await runDaily();
              await publisher.publish(
                trx,
                RoutineCompletedV1,
                { ...p, stats },
                {
                  partitionKey: p.routineName,
                  aggregateType: 'routine_execution',
                  aggregateId: `${p.routineName}@${p.businessDate}`,
                  actor: { type: 'SYSTEM', id: d.config.SERVICE_NAME },
                },
              );
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
    if (d.consumeLedgerEvents) {
      const actor = { type: 'SYSTEM' as const, id: 'ledger-service' };
      consumers.push(
        new EventConsumer({
          ...base,
          name: 'customer.ledger',
          superStream: topicName(environment, 'ledger'),
          handlers: {
            'ledger.negative_balance_detected': {
              definition: LedgerNegativeBalanceDetectedV1,
              handle: async (trx, e) => {
                await accounts.setRestriction(
                  store.tx(trx),
                  (e.payload as { accountId: string }).accountId,
                  'NEGATIVE_BALANCE',
                  true,
                  actor,
                );
              },
            },
            'ledger.negative_balance_cleared': {
              definition: LedgerNegativeBalanceClearedV1,
              handle: async (trx, e) => {
                await accounts.setRestriction(
                  store.tx(trx),
                  (e.payload as { accountId: string }).accountId,
                  'NEGATIVE_BALANCE',
                  false,
                  actor,
                );
              },
            },
          },
        }),
      );
    }
  }

  const service = createService({
    config: d.config,
    clock: d.clock,
    logger: d.logger,
    authenticator: d.authenticator,
    signatureVerifier: d.signatureVerifier,
    // Comandos com efeito externo (upload, submissão, conta de saque) exigem Idempotency-Key.
    idempotency: new IdempotencyStore({ db: d.db }),
    readiness: { database: () => sql`SELECT 1`.execute(d.db) },
  });
  registerHttp(service, {
    onboarding,
    suitability,
    accounts,
    clock: d.clock,
    kycWebhookSecret: d.kycWebhookSecret,
  });

  let timer: NodeJS.Timeout | undefined;
  return {
    service,
    store,
    onboarding,
    suitability,
    accounts,
    opening,
    sagas,
    resumeOpenings,
    runDaily,
    async start() {
      await relay?.start();
      for (const c of consumers) await c.start();
      await resumeOpenings();
      timer = setInterval(() => {
        void resumeOpenings().catch((err: unknown) =>
          d.logger.error({ event: 'opening.resume_failed', err }, 'falha ao retomar aberturas'),
        );
      }, d.sagaResumeMs ?? 10_000);
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
