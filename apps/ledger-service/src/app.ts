import type { CalendarData } from '@broker/calendar';
import { TickedClock, type Clock } from '@broker/clock';
import { AccountOpenedV1 } from '@broker/contracts/events/account.opened/v1';
import { AccountStatusChangedV1 } from '@broker/contracts/events/account.status_changed/v1';
import { CalendarUpdatedV1 } from '@broker/contracts/events/calendar.updated/v1';
import { ClockTickedV1 } from '@broker/contracts/events/clock.ticked/v1';
import { RiskHoldAdjustedV1 } from '@broker/contracts/events/risk.hold_adjusted/v1';
import { RiskHoldConsumedV1 } from '@broker/contracts/events/risk.hold_consumed/v1';
import { RiskHoldCreatedV1 } from '@broker/contracts/events/risk.hold_created/v1';
import { RiskHoldReleasedV1 } from '@broker/contracts/events/risk.hold_released/v1';
import { RoutineTriggeredV1 } from '@broker/contracts/events/routine.triggered/v1';
import { SessionScheduleUpdatedV1 } from '@broker/contracts/events/session_schedule.updated/v1';
import { BusinessDate, Money } from '@broker/domain-kernel';
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
import { CalendarReplica, EnvironmentClockReplica, type DatabaseConfig } from '@broker/persistence';
import {
  createService,
  IdempotencyStore,
  type Authenticator,
  type BaseConfig,
  type SignatureVerifier,
} from '@broker/service-kit';
import { sql, type Kysely } from 'kysely';
import { registerHttp } from './adapters/http.js';
import { PostgresLedgerStore } from './adapters/postgres-store.js';
import { LedgerAccounts } from './application/accounts.js';
import type { LedgerDeps } from './application/context.js';
import { Deposits } from './application/deposits.js';
import type { LedgerStore } from './application/ports.js';
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
  /** Porta dos holds: o RPC do risk-service. Recebe a loja para a cópia de `risk.hold_*`. */
  holds: (store: LedgerStore) => LedgerDeps['holds'];
  stream?: StreamSettings;
  /** Consome `account.opened`/`account.status_changed` do customer-service. */
  consumeCustomerEvents?: boolean;
  /** Consome `calendar.updated`/`session_schedule.updated` do reference-data (padrão: sim). */
  consumeCalendarEvents?: boolean;
  /** Intervalo do laço de saques, devoluções e expirações (padrão 2 s). */
  workerIntervalMs?: number;
}

/** Monta o ledger-service (catálogo de serviços §3). */
export async function createLedgerService(d: LedgerServiceDeps) {
  const environment = d.config.ENVIRONMENT;
  // Relógio VIRTUAL/ACCELERATED: retoma o último instante do ambiente antes de qualquer uso; sem
  // isso, o serviço reiniciado voltaria ao CLOCK_START até o próximo `clock.ticked` (RN-CLK-003).
  const environmentClock =
    d.clock instanceof TickedClock ? new EnvironmentClockReplica(d.db, d.clock) : undefined;
  await environmentClock?.restore();
  const publisher = new EventPublisher({
    source: d.config.SERVICE_NAME,
    environment,
    clock: d.clock,
    newId: d.newId,
  });
  const store = new PostgresLedgerStore(d.db, publisher);
  // Cópia local do calendário (D15): a semente de `d.calendar` dá lugar à última gravada.
  const calendarReplica = new CalendarReplica(d.db, d.calendar);
  await calendarReplica.refresh();
  const holds = d.holds(store);
  const deps: LedgerDeps = { ...d, store, holds };
  const ledger = new Ledger(deps);
  const accounts = new LedgerAccounts(deps);
  const deposits = new Deposits(deps, ledger);
  const withdrawals = new Withdrawals(deps, ledger);
  const statement = new Statement(deps);
  const reconciliation = new PixReconciliation(deps);

  /** Uma rodada do trabalho de fundo: tudo idempotente e retomável depois de um reinício. */
  const work = async () => {
    // As instâncias que não consomem o calendário (SAC) acompanham a cópia gravada.
    await calendarReplica.refresh();
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
    const riskStream = topicName(environment, 'risk');
    await ensureSuperStream(client, riskStream, { maxAge: '90D' });
    const copyHold = async (trx: Kysely<unknown>, e: { payload: unknown }) => {
      const p = e.payload as {
        holdId: string;
        accountId: string;
        resource: string;
        amount: string;
      };
      if (p.resource !== 'CASH') return;
      await store.tx(trx).upsertHoldCopy({
        holdId: p.holdId,
        accountId: p.accountId,
        amount: Money.of(p.amount, 'BRL'),
      });
    };
    const dropHold = async (trx: Kysely<unknown>, e: { payload: unknown }) => {
      await store.tx(trx).deleteHoldCopy((e.payload as { holdId: string }).holdId);
    };
    consumers.push(
      new EventConsumer({
        ...base,
        // Ordenado por conta: um `consumed` não passa na frente do `created` do mesmo hold.
        ordered: true,
        name: 'ledger.risk',
        superStream: riskStream,
        startFrom: 'first',
        handlers: {
          'risk.hold_created': { definition: RiskHoldCreatedV1, handle: copyHold },
          'risk.hold_adjusted': { definition: RiskHoldAdjustedV1, handle: copyHold },
          'risk.hold_released': { definition: RiskHoldReleasedV1, handle: dropHold },
          'risk.hold_consumed': { definition: RiskHoldConsumedV1, handle: dropHold },
        },
      }),
    );
    if (d.consumeCalendarEvents ?? true) {
      const referenceStream = topicName(environment, 'reference');
      await ensureSuperStream(client, referenceStream, { maxAge: '30D' });
      const apply = async (
        trx: Kysely<unknown>,
        e: { eventId: string; occurredAt: string; payload: unknown },
      ) => {
        await calendarReplica.apply(trx, {
          data: (e.payload as { calendar: CalendarData }).calendar,
          eventId: e.eventId,
          occurredAt: e.occurredAt,
        });
      };
      consumers.push(
        new EventConsumer({
          ...base,
          // Todos com a chave `calendar`: em ordem, o último evento é o calendário vigente.
          ordered: true,
          name: 'ledger.calendar',
          superStream: referenceStream,
          startFrom: 'first',
          handlers: {
            'calendar.updated': { definition: CalendarUpdatedV1, handle: apply },
            'session_schedule.updated': { definition: SessionScheduleUpdatedV1, handle: apply },
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
            handle: async (trx, e) => {
              await environmentClock?.apply(trx, e.payload as { virtualNow: string });
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
    calendarReplica,
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
