import { TickedClock, type Clock } from '@broker/clock';
import { AccountOpenedV1 } from '@broker/contracts/events/account.opened/v1';
import { AccountStatusChangedV1 } from '@broker/contracts/events/account.status_changed/v1';
import { ClockTickedV1 } from '@broker/contracts/events/clock.ticked/v1';
import { RoutineTriggeredV1 } from '@broker/contracts/events/routine.triggered/v1';
import { BusinessDate } from '@broker/domain-kernel';
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
  type Authenticator,
  type BaseConfig,
  type SignatureVerifier,
} from '@broker/service-kit';
import { sql, type Kysely } from 'kysely';
import { registerHttp } from './adapters/http.js';
import { LocalRiskHoldPort } from './adapters/local-risk-hold.js';
import { PostgresLedgerStore } from './adapters/postgres-store.js';
import { LedgerAccounts } from './application/accounts.js';
import type { LedgerDeps } from './application/context.js';
import { Deposits } from './application/deposits.js';
import { Ledger } from './application/posting.js';
import { PixReconciliation } from './application/reconciliation.js';
import { Statement } from './application/statement.js';
import { Withdrawals } from './application/withdrawals.js';

/** Rotina do agendador: reconciliação PIX do dia (RN-PIXS-002). */
export const PIX_RECONCILIATION_ROUTINE = 'pix_reconciliation';

export interface LedgerServiceDeps extends Omit<LedgerDeps, 'store' | 'holds'> {
  config: BaseConfig;
  db: Kysely<unknown>;
  database: DatabaseConfig;
  clock: Clock;
  authenticator: Authenticator;
  signatureVerifier: SignatureVerifier;
  pixWebhookSecret: string;
  /** Porta dos holds; sem ela, o adaptador provisório local da Fase 1. */
  holds?: LedgerDeps['holds'];
  stream?: StreamSettings;
  /** Consome `account.opened`/`account.status_changed` do customer-service. */
  consumeCustomerEvents?: boolean;
  /** Intervalo do laço de saques, devoluções e expirações (padrão 2 s). */
  workerIntervalMs?: number;
}

/** Monta o ledger-service (catálogo de serviços §3). */
export async function createLedgerService(d: LedgerServiceDeps) {
  const environment = d.config.ENVIRONMENT;
  const publisher = new EventPublisher({
    source: d.config.SERVICE_NAME,
    environment,
    clock: d.clock,
    newId: d.newId,
  });
  const store = new PostgresLedgerStore(d.db, publisher);
  const holds = d.holds ?? new LocalRiskHoldPort({ store, clock: d.clock, calendar: d.calendar });
  const deps: LedgerDeps = { ...d, store, holds };
  const ledger = new Ledger(deps);
  const accounts = new LedgerAccounts(deps);
  const deposits = new Deposits(deps, ledger);
  const withdrawals = new Withdrawals(deps, ledger);
  const statement = new Statement(deps);
  const reconciliation = new PixReconciliation(deps);

  /** Uma rodada do trabalho de fundo: tudo idempotente e retomável depois de um reinício. */
  const work = async () => {
    await deposits.expireDue();
    await deposits.processRefunds();
    await withdrawals.processDue();
  };

  let relay: OutboxRelay | undefined;
  const consumers: EventConsumer[] = [];
  let closeStream: (() => Promise<void>) | undefined;
  if (d.stream) {
    const client = await connectStream(d.stream, d.config.SERVICE_NAME);
    closeStream = () => client.close();
    const superStream = topicName(environment, 'ledger');
    // ledger.events: 90 dias (Mensageria, Diretrizes §2).
    await ensureSuperStream(client, superStream, { maxAge: '90D' });
    await ensureSuperStream(client, topicName(environment, 'scheduler'), {
      partitions: 1,
      maxAge: '30D',
    });
    await ensureSuperStream(client, topicName(environment, 'customer'), { maxAge: '30D' });
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

    if (d.consumeCustomerEvents ?? true) {
      consumers.push(
        new EventConsumer({
          ...base,
          // Ordenado por conta: o status não pode passar na frente da abertura (RN-MSG-B-035).
          ordered: true,
          name: 'ledger.customer',
          superStream: topicName(environment, 'customer'),
          startFrom: 'first',
          handlers: {
            'account.opened': {
              definition: AccountOpenedV1,
              handle: async (trx, e) => {
                await accounts.onAccountOpened(
                  store.tx(trx),
                  e.payload as {
                    accountId: string;
                    customerId: string;
                    accountNumber: string;
                    openedAt: string;
                  },
                );
              },
            },
            'account.status_changed': {
              definition: AccountStatusChangedV1,
              handle: async (trx, e) => {
                await accounts.onStatusChanged(
                  store.tx(trx),
                  e.payload as { accountId: string; to: string },
                );
              },
            },
          },
        }),
      );
    }
    consumers.push(
      new EventConsumer({
        ...base,
        ordered: false,
        name: 'ledger.scheduler',
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
              if (p.routineName !== PIX_RECONCILIATION_ROUTINE) return;
              const rec = await reconciliation.run(BusinessDate.parse(p.businessDate));
              await store.tx(trx).publish(
                {
                  type: 'routine.completed',
                  payload: {
                    ...p,
                    stats: {
                      status: rec.status,
                      checked: rec.checked,
                      divergences: rec.divergences.length,
                    },
                  },
                },
                p.routineName,
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
  }

  const service = createService({
    config: d.config,
    clock: d.clock,
    logger: d.logger,
    authenticator: d.authenticator,
    signatureVerifier: d.signatureVerifier,
    idempotency: new IdempotencyStore({ db: d.db }),
    readiness: { database: () => sql`SELECT 1`.execute(d.db) },
  });
  registerHttp(service, {
    ledger,
    accounts,
    deposits,
    withdrawals,
    statement,
    store,
    clock: d.clock,
    pixWebhookSecret: d.pixWebhookSecret,
  });

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  return {
    service,
    store,
    holds,
    ledger,
    accounts,
    deposits,
    withdrawals,
    statement,
    reconciliation,
    work,
    async start() {
      await relay?.start();
      for (const c of consumers) await c.start();
      timer = setInterval(() => {
        if (running) return;
        running = true;
        void work()
          .catch((err: unknown) =>
            d.logger.error({ event: 'ledger.worker_failed', err }, 'falha no laço de fundo'),
          )
          .finally(() => (running = false));
      }, d.workerIntervalMs ?? 2000);
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
