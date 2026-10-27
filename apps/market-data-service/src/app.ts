import type { CalendarData, TradingCalendar } from '@broker/calendar';
import { TickedClock, type Clock } from '@broker/clock';
import { CalendarUpdatedV1 } from '@broker/contracts/events/calendar.updated/v1';
import { ClockTickedV1 } from '@broker/contracts/events/clock.ticked/v1';
import { InstrumentCreatedV1 } from '@broker/contracts/events/instrument.created/v1';
import { InstrumentStatusChangedV1 } from '@broker/contracts/events/instrument.status_changed/v1';
import { InstrumentSymbolChangedV1 } from '@broker/contracts/events/instrument.symbol_changed/v1';
import { InstrumentTradabilityChangedV1 } from '@broker/contracts/events/instrument.tradability_changed/v1';
import { InstrumentUpdatedV1 } from '@broker/contracts/events/instrument.updated/v1';
import { RoutineTriggeredV1 } from '@broker/contracts/events/routine.triggered/v1';
import { SessionScheduleUpdatedV1 } from '@broker/contracts/events/session_schedule.updated/v1';
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
import { CalendarReplica, LeaderElector, type DatabaseConfig } from '@broker/persistence';
import {
  createService,
  IdempotencyStore,
  type Authenticator,
  type BaseConfig,
  type Logger,
} from '@broker/service-kit';
import { sql, type Kysely } from 'kysely';
import { NoCorporateActionsYet, NoExposureYet } from './adapters/exposure.js';
import { registerHttp } from './adapters/http.js';
import { PostgresMarketDataStore } from './adapters/postgres-store.js';
import { BudgetController } from './application/budget.js';
import { Catalog } from './application/catalog.js';
import { DEFAULT_PLAN, type MarketDataDeps, type PlanSettings } from './application/context.js';
import { ProviderHealth } from './application/errors.js';
import { InstrumentReplica } from './application/instruments.js';
import { OnDemandQuotes } from './application/on-demand.js';
import { QuotePoller } from './application/polling.js';
import type {
  CorporateActionsPort,
  ExposurePort,
  ProviderAlert,
  ProviderCache,
  RawStorage,
} from './application/ports.js';
import type { MarketDataProvider } from './application/provider.js';
import { ProviderQueue } from './application/queue.js';
import { Quotes } from './application/quotes.js';
import { ReferencePrices } from './application/reference-prices.js';
import { MARKET_DATA_ROUTINES, RoutineJobs } from './application/routines.js';
import {
  SchemaCheck,
  type SchemaCheckSettings,
  type SchemaProbe,
} from './application/schema-check.js';
import { DEFAULT_BUDGET_POLICY, type BudgetPolicy } from './domain/budget.js';
import { CircuitBreaker, DEFAULT_BREAKER, type BreakerOptions } from './domain/circuit-breaker.js';
import { DEFAULT_SYNTHETIC, type SyntheticParams } from './domain/reference-price.js';

export interface MarketDataServiceDeps {
  config: BaseConfig;
  db: Kysely<unknown>;
  database: DatabaseConfig;
  clock: Clock;
  calendar: TradingCalendar;
  logger: Logger;
  newId: () => string;
  authenticator: Authenticator;
  /** Provedor (brapi, fixtures ou replay); o replay lê o histórico pelo próprio store. */
  provider: MarketDataProvider | ((store: PostgresMarketDataStore) => MarketDataProvider);
  cache: ProviderCache;
  raw: RawStorage;
  plan?: Partial<PlanSettings>;
  budgetPolicy?: Partial<BudgetPolicy>;
  synthetic?: Partial<SyntheticParams>;
  queue?: { maxConcurrency?: number; minIntervalMs?: number; breaker?: BreakerOptions };
  schemaCheck?: SchemaCheckSettings & { probes?: SchemaProbe[] };
  /** Impressão digital do token em uso (trava do `401`, RN-BRP-094). */
  tokenFingerprint?: () => Promise<string | null>;
  exposure?: ExposurePort;
  corporateActions?: CorporateActionsPort;
  /** Liderança da fila (D14); sem ela, um `LeaderElector` no banco do serviço. */
  leader?: { isLeader(): boolean; start?(): Promise<void>; stop?(): Promise<void> };
  random?: () => number;
  onAlert?: (alert: ProviderAlert) => void;
  stream?: StreamSettings;
  /** Intervalo do laço do líder (padrão 1 s). */
  workerIntervalMs?: number;
}

/** Monta o market-data-service (catálogo de serviços §5). */
export async function createMarketDataService(d: MarketDataServiceDeps) {
  const environment = d.config.ENVIRONMENT;
  const publisher = new EventPublisher({
    source: d.config.SERVICE_NAME,
    environment,
    clock: d.clock,
    newId: d.newId,
  });
  const store = new PostgresMarketDataStore(d.db, publisher);
  const provider = typeof d.provider === 'function' ? d.provider(store) : d.provider;
  const calendarReplica = new CalendarReplica(d.db, d.calendar);
  await calendarReplica.refresh();

  const deps: MarketDataDeps = {
    store,
    provider,
    cache: d.cache,
    raw: d.raw,
    clock: d.clock,
    calendar: d.calendar,
    newId: d.newId,
    logger: d.logger,
    environment,
    plan: { ...DEFAULT_PLAN, ...d.plan },
    budgetPolicy: { ...DEFAULT_BUDGET_POLICY, ...d.budgetPolicy },
    synthetic: { ...DEFAULT_SYNTHETIC, ...d.synthetic },
    exposure: d.exposure ?? new NoExposureYet(),
    corporateActions: d.corporateActions ?? new NoCorporateActionsYet(),
    random: d.random ?? Math.random,
    ...(d.onAlert ? { onAlert: d.onAlert } : {}),
  };

  const budget = new BudgetController(deps);
  const health = new ProviderHealth(deps);
  await budget.load();
  await health.load();

  const leader =
    d.leader ??
    new LeaderElector({
      database: d.database,
      name: 'brapi-queue',
      onElected: () => {
        d.logger.info({ event: 'market_data.leader_elected' }, 'líder da fila da brapi');
        queue.pump();
      },
      onRevoked: (reason) =>
        d.logger.warn({ event: 'market_data.leader_revoked', reason }, 'perdeu a liderança'),
      onError: (err) =>
        d.logger.warn({ event: 'market_data.leader_error', err }, 'falha na eleição'),
    });

  const queue: ProviderQueue = new ProviderQueue({
    maxConcurrency: d.queue?.maxConcurrency ?? 1,
    minIntervalMs: d.queue?.minIntervalMs ?? 1000,
    breaker: new CircuitBreaker(d.queue?.breaker ?? DEFAULT_BREAKER),
    isLeader: () => leader.isLeader(),
    gate: (kind, priority, symbol) => health.gate(kind) ?? budget.gate(kind, priority, symbol),
    onSent: (kind, outcome) => budget.onSent(kind, outcome),
    onError: (err) => d.logger.error({ event: 'market_data.queue_error', err }, 'falha na fila'),
  });

  const references = new ReferencePrices(deps);
  const catalog = new Catalog(deps, queue, health);
  const quotes = new Quotes(deps, () => budget.level(), {
    onAccepted: (q) => references.onAccepted(q),
    onSymbolChanged: (symbol) => {
      void catalog.resolveUniverse([symbol]).catch(() => undefined);
    },
  });
  const poller = new QuotePoller(deps, queue, quotes, budget, health);
  const onDemand = new OnDemandQuotes(deps, queue, quotes, budget, health);
  const instruments = new InstrumentReplica();
  const jobs = new RoutineJobs(deps, {
    [MARKET_DATA_ROUTINES.closeSnapshot]: async () => ({ ...(await poller.closeSnapshot()) }),
    [MARKET_DATA_ROUTINES.dailyClose]: async () => ({ references: await references.tick() }),
  });
  const schemaCheck = new SchemaCheck(
    deps,
    queue,
    d.schemaCheck ?? { enabled: false, weekday: 1, at: '07:00' },
    d.schemaCheck?.probes ?? [],
  );

  /** E9 quando vence (1×/h no pregão, 1×/6 h fora), pela fila em P5. */
  const pollUsage = async () => {
    if (!budget.usageDue(poller.inSession())) return;
    const res = await queue.enqueue({
      key: 'usage',
      kind: 'USAGE',
      priority: 5,
      run: () => provider.getUsage(),
    });
    if (res.value) await budget.applyUsage(res.value);
  };

  let relay: OutboxRelay | undefined;
  const consumers: EventConsumer[] = [];
  let closeStream: (() => Promise<void>) | undefined;
  if (d.stream) {
    const client = await connectStream(d.stream, d.config.SERVICE_NAME);
    closeStream = () => client.close();
    const superStream = topicName(environment, 'market-data');
    // market-data.events: 30 dias (Mensageria, Diretrizes §2).
    await ensureSuperStream(client, superStream, { maxAge: '30D' });
    await ensureSuperStream(client, topicName(environment, 'scheduler'), {
      partitions: 1,
      maxAge: '30D',
    });
    await ensureSuperStream(client, topicName(environment, 'reference'), { maxAge: '30D' });
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
    const state = async (trx: Kysely<unknown>, e: { payload: unknown }) => {
      await instruments.onState(
        store.tx(trx),
        e.payload as {
          instrumentId: string;
          symbol: string;
          tickSize: string;
          tradable: boolean;
          status: string;
        },
      );
    };
    const calendar = async (
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
        // Por instrumento (e `calendar`): o status não passa na frente do cadastro.
        ordered: true,
        name: 'market_data.reference',
        superStream: topicName(environment, 'reference'),
        startFrom: 'first',
        handlers: {
          'instrument.created': { definition: InstrumentCreatedV1, handle: state },
          'instrument.updated': { definition: InstrumentUpdatedV1, handle: state },
          'instrument.tradability_changed': {
            definition: InstrumentTradabilityChangedV1,
            handle: async (trx, e) => {
              await instruments.onTradability(
                store.tx(trx),
                e.payload as { instrumentId: string; tradable: boolean },
              );
            },
          },
          'instrument.symbol_changed': {
            definition: InstrumentSymbolChangedV1,
            handle: async (trx, e) => {
              await instruments.onSymbolChanged(
                store.tx(trx),
                e.payload as { instrumentId: string; newSymbol: string },
              );
            },
          },
          'instrument.status_changed': {
            definition: InstrumentStatusChangedV1,
            handle: async (trx, e) => {
              await instruments.onStatusChanged(
                store.tx(trx),
                e.payload as { instrumentId: string; to: string },
              );
            },
          },
          'calendar.updated': { definition: CalendarUpdatedV1, handle: calendar },
          'session_schedule.updated': { definition: SessionScheduleUpdatedV1, handle: calendar },
        },
      }),
    );
    consumers.push(
      new EventConsumer({
        ...base,
        ordered: false,
        name: 'market_data.scheduler',
        superStream: topicName(environment, 'scheduler'),
        handlers: {
          'routine.triggered': {
            definition: RoutineTriggeredV1,
            handle: async (trx, e) => {
              await jobs.onTriggered(
                store.tx(trx),
                e.payload as { routineName: string; businessDate: string; executionId: string },
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
    idempotency: new IdempotencyStore({ db: d.db }),
    readiness: { database: () => sql`SELECT 1`.execute(d.db) },
  });
  registerHttp(service, {
    store,
    onDemand,
    catalog,
    references,
    budget,
    queue,
    providerName: provider.name,
    isLeader: () => leader.isLeader(),
  });

  /**
   * Trabalho de fundo do líder. Cada tarefa tem a própria trava: uma lenta (catálogo pela fila)
   * não segura as outras (o preço de referência anda a cada rodada).
   */
  const busy = new Set<string>();
  const task = (name: string, fn: () => Promise<unknown>) => {
    if (busy.has(name)) return;
    busy.add(name);
    void fn()
      .catch((err: unknown) =>
        d.logger.error(
          { event: 'market_data.worker_failed', task: name, err },
          'falha no laço de fundo',
        ),
      )
      .finally(() => busy.delete(name));
  };
  const work = async () => {
    await calendarReplica.refresh();
    if (d.tokenFingerprint) budget.setTokenFingerprint(await d.tokenFingerprint());
    if (!leader.isLeader()) return;
    task('budget', async () => {
      await budget.refresh();
      await pollUsage();
    });
    task('poll', () => poller.tick());
    task('stale', () => quotes.checkStale());
    task('reference', () => references.tick());
    task('jobs', () => jobs.runPending());
    task('catalog', () => catalog.syncIfDue());
    task('history', () => catalog.backfillHistory());
    task('schema', () => schemaCheck.runIfDue());
  };

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  return {
    service,
    store,
    provider,
    queue,
    budget,
    health,
    quotes,
    poller,
    catalog,
    references,
    onDemand,
    instruments,
    jobs,
    schemaCheck,
    calendarReplica,
    work,
    async start() {
      await leader.start?.();
      await relay?.start();
      for (const c of consumers) await c.start();
      timer = setInterval(() => {
        if (running) return;
        running = true;
        void work()
          .catch((err: unknown) =>
            d.logger.error({ event: 'market_data.worker_failed', err }, 'falha no laço de fundo'),
          )
          .finally(() => (running = false));
      }, d.workerIntervalMs ?? 1000);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      queue.stop();
      for (const c of consumers) await c.stop();
      await relay?.stop();
      await closeStream?.();
      await leader.stop?.();
    },
  };
}
