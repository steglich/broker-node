import { TickedClock, type Clock } from '@broker/clock';
import { ClockTickedV1 } from '@broker/contracts/events/clock.ticked/v1';
import { MarketDataCatalogSyncedV1 } from '@broker/contracts/events/market_data.catalog_synced/v1';
import { MarketDataInstrumentStaleV1 } from '@broker/contracts/events/market_data.instrument_stale/v1';
import { MarketDataSymbolRenameDetectedV1 } from '@broker/contracts/events/market_data.symbol_rename_detected/v1';
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
  type Authenticator,
  type BaseConfig,
} from '@broker/service-kit';
import { sql, type Kysely } from 'kysely';
import { registerHttp } from './adapters/http.js';
import { NoOpenOrdersYet } from './adapters/local-open-orders.js';
import { PostgresReferenceStore } from './adapters/postgres-store.js';
import { CalendarService } from './application/calendar.js';
import { ChangeRequests } from './application/change-requests.js';
import type { ReferenceDeps } from './application/context.js';
import { Instruments, type CatalogEntry } from './application/instruments.js';
import { Renames } from './application/renames.js';
import { TradingRules } from './application/trading-rules.js';
import { Universe } from './application/universe.js';

/** Rotina diária (agendador): alerta de calendário (RN-CAL-001) e suspensão por defasagem (RN-INS-020). */
export const REFERENCE_DAILY_ROUTINE = 'reference_daily';

export interface ReferenceServiceDeps extends Omit<ReferenceDeps, 'store' | 'openOrders'> {
  config: BaseConfig;
  db: Kysely<unknown>;
  database: DatabaseConfig;
  clock: Clock;
  authenticator: Authenticator;
  /** Ordens abertas por instrumento; sem ela, o adaptador provisório da Fase 1 (zero). */
  openOrders?: ReferenceDeps['openOrders'];
  stream?: StreamSettings;
  /** Intervalo do laço de fundo (expiração das solicitações; padrão 5 s). */
  workerIntervalMs?: number;
}

/** Monta o reference-data-service (catálogo de serviços §4). */
export async function createReferenceDataService(d: ReferenceServiceDeps) {
  const environment = d.config.ENVIRONMENT;
  const publisher = new EventPublisher({
    source: d.config.SERVICE_NAME,
    environment,
    clock: d.clock,
    newId: d.newId,
  });
  const store = new PostgresReferenceStore(d.db, publisher);
  const deps: ReferenceDeps = { ...d, store, openOrders: d.openOrders ?? new NoOpenOrdersYet() };
  const requests = new ChangeRequests(deps);
  const calendar = new CalendarService(deps, requests);
  const instruments = new Instruments(deps, calendar);
  const universe = new Universe(deps, instruments, requests);
  const renames = new Renames(deps, instruments);
  const rules = new TradingRules(deps, requests);

  /** Rotina diária: idempotente (a tarefa do calendário tem chave; suspender de novo é no-op). */
  const daily = async () => {
    const coverage = await store.transaction((tx) =>
      calendar.checkCoverage(tx, (t) => instruments.openTask(tx, t)),
    );
    const suspended = await instruments.suspendStale();
    return { ...coverage, suspended };
  };

  let relay: OutboxRelay | undefined;
  const consumers: EventConsumer[] = [];
  let closeStream: (() => Promise<void>) | undefined;
  if (d.stream) {
    const client = await connectStream(d.stream, d.config.SERVICE_NAME);
    closeStream = () => client.close();
    const superStream = topicName(environment, 'reference');
    // reference.events: último estado + 30 dias (Mensageria, Diretrizes §2). Streams não compactam:
    // a cópia inicial de um consumidor novo vem de GET /v1/instruments e /v1/calendar.
    await ensureSuperStream(client, superStream, { maxAge: '30D' });
    await ensureSuperStream(client, topicName(environment, 'scheduler'), {
      partitions: 1,
      maxAge: '30D',
    });
    await ensureSuperStream(client, topicName(environment, 'market-data'), { maxAge: '30D' });
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

    consumers.push(
      new EventConsumer({
        ...base,
        ordered: false,
        name: 'reference.market_data',
        superStream: topicName(environment, 'market-data'),
        startFrom: 'first',
        handlers: {
          'market_data.catalog_synced': {
            definition: MarketDataCatalogSyncedV1,
            handle: async (trx, e) => {
              await instruments.onCatalogSynced(
                store.tx(trx),
                e.payload as {
                  newSymbols: CatalogEntry[];
                  inactiveSymbols: string[];
                  syncedAt: string;
                },
              );
            },
          },
          'market_data.symbol_rename_detected': {
            definition: MarketDataSymbolRenameDetectedV1,
            handle: async (trx, e) => {
              await renames.onRenameDetected(
                store.tx(trx),
                e.payload as {
                  oldSymbol: string;
                  newSymbol: string;
                  effectiveDate: string;
                  conversionRatio?: string;
                },
              );
            },
          },
          'market_data.instrument_stale': {
            definition: MarketDataInstrumentStaleV1,
            handle: async (trx, e) => {
              await instruments.onInstrumentStale(
                store.tx(trx),
                e.payload as { instrumentId: string; staleSince: string },
              );
            },
          },
        },
      }),
    );
    consumers.push(
      new EventConsumer({
        ...base,
        ordered: false,
        name: 'reference.scheduler',
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
              if (p.routineName !== REFERENCE_DAILY_ROUTINE) return;
              const stats = await daily();
              await store
                .tx(trx)
                .publish({ type: 'routine.completed', payload: { ...p, stats } }, p.routineName);
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
    idempotency: new IdempotencyStore({ db: d.db }),
    readiness: { database: () => sql`SELECT 1`.execute(d.db) },
  });
  registerHttp(service, { instruments, universe, renames, rules, calendar, requests });

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  return {
    service,
    store,
    requests,
    calendar,
    instruments,
    universe,
    renames,
    rules,
    daily,
    async start() {
      await relay?.start();
      for (const c of consumers) await c.start();
      timer = setInterval(() => {
        if (running) return;
        running = true;
        void requests
          .expireDue()
          .catch((err: unknown) =>
            d.logger.error({ event: 'reference.worker_failed', err }, 'falha no laço de fundo'),
          )
          .finally(() => (running = false));
      }, d.workerIntervalMs ?? 5000);
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
