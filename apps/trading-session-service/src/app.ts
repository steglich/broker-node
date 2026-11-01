import type { TradingCalendar, CalendarData } from '@broker/calendar';
import { TickedClock, type Clock } from '@broker/clock';
import { CalendarUpdatedV1 } from '@broker/contracts/events/calendar.updated/v1';
import { ClockTickedV1 } from '@broker/contracts/events/clock.ticked/v1';
import { EngineAuctionCompletedV1 } from '@broker/contracts/events/engine.auction_completed/v1';
import { EngineAuctionIndicativeV1 } from '@broker/contracts/events/engine.auction_indicative/v1';
import { EngineAuctionTriggeredV1 } from '@broker/contracts/events/engine.auction_triggered/v1';
import { EngineBookRecoveredV1 } from '@broker/contracts/events/engine.book_recovered/v1';
import { EngineBookRecoveringV1 } from '@broker/contracts/events/engine.book_recovering/v1';
import { EngineTradeExecutedV1 } from '@broker/contracts/events/engine.trade_executed/v1';
import { InstrumentCreatedV1 } from '@broker/contracts/events/instrument.created/v1';
import { InstrumentStatusChangedV1 } from '@broker/contracts/events/instrument.status_changed/v1';
import { InstrumentTradabilityChangedV1 } from '@broker/contracts/events/instrument.tradability_changed/v1';
import { InstrumentTradingRulesChangedV1 } from '@broker/contracts/events/instrument.trading_rules_changed/v1';
import { InstrumentUpdatedV1 } from '@broker/contracts/events/instrument.updated/v1';
import { MarketDataExternalQuoteReceivedV1 } from '@broker/contracts/events/market_data.external_quote_received/v1';
import { MarketDataProviderBudgetLevelChangedV1 } from '@broker/contracts/events/market_data.provider_budget_level_changed/v1';
import { MarketDataReferencePriceUpdatedV1 } from '@broker/contracts/events/market_data.reference_price_updated/v1';
import { RoutineTriggeredV1 } from '@broker/contracts/events/routine.triggered/v1';
import { SessionScheduleUpdatedV1 } from '@broker/contracts/events/session_schedule.updated/v1';
import { Instant } from '@broker/domain-kernel';
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
import {
  CalendarReplica,
  EnvironmentClockReplica,
  LeaderElector,
  type DatabaseConfig,
} from '@broker/persistence';
import {
  createService,
  IdempotencyStore,
  type Authenticator,
  type BaseConfig,
  type Logger,
} from '@broker/service-kit';
import { sql, type Kysely } from 'kysely';
import { registerHttp } from './adapters/http.js';
import { PostgresSessionStore } from './adapters/postgres-store.js';
import { Backoffice } from './application/backoffice.js';
import { DEFAULT_SESSION_PARAMS, type SessionParams } from './application/context.js';
import { SessionQueries } from './application/queries.js';
import { Session } from './application/session.js';
import type { SessionRules } from './domain/trading-rules.js';

export interface SessionServiceDeps {
  config: BaseConfig;
  db: Kysely<unknown>;
  database: DatabaseConfig;
  logger: Logger;
  clock: Clock;
  /** Semente do calendário; vira a cópia local alimentada por `calendar.updated` (D15). */
  calendar: TradingCalendar;
  newId: () => string;
  authenticator: Authenticator;
  params?: Partial<SessionParams>;
  sandboxCommands?: boolean;
  stream?: StreamSettings;
  /** Intervalo do laço do líder (padrão 1 s). */
  loopIntervalMs?: number;
  leaderHeartbeatMs?: number;
}

/**
 * Monta o trading-session-service (catálogo de serviços §6). Ativo/passivo: só o líder roda o laço
 * dos prazos e o relay da outbox; os consumidores são SAC e as réplicas servem as leituras.
 */
export async function createSessionService(d: SessionServiceDeps) {
  const environment = d.config.ENVIRONMENT;
  const environmentClock =
    d.clock instanceof TickedClock ? new EnvironmentClockReplica(d.db, d.clock) : undefined;
  await environmentClock?.restore();
  const calendarReplica = new CalendarReplica(d.db, d.calendar);
  await calendarReplica.refresh();
  const publisher = new EventPublisher({
    source: d.config.SERVICE_NAME,
    environment,
    clock: d.clock,
    newId: d.newId,
  });
  const store = new PostgresSessionStore(d.db, publisher);
  const deps = {
    store,
    clock: d.clock,
    calendar: d.calendar,
    newId: d.newId,
    logger: d.logger,
    params: { ...DEFAULT_SESSION_PARAMS, ...d.params },
  };
  const session = new Session(deps);
  const backoffice = new Backoffice(deps, session);
  const queries = new SessionQueries(deps);

  let relay: OutboxRelay | undefined;
  const consumers: EventConsumer[] = [];
  let closeStream: (() => Promise<void>) | undefined;
  if (d.stream) {
    const client = await connectStream(d.stream, d.config.SERVICE_NAME);
    closeStream = () => client.close();
    const superStream = topicName(environment, 'session');
    const commands = topicName(environment, 'engine', 'commands');
    // Retenções de RN-MSG-B-002.
    await ensureSuperStream(client, superStream, { maxAge: '30D' });
    await ensureSuperStream(client, commands, { maxAge: '30D' });
    await ensureSuperStream(client, topicName(environment, 'engine'), { maxAge: '90D' });
    await ensureSuperStream(client, topicName(environment, 'scheduler'), {
      partitions: 1,
      maxAge: '30D',
    });
    await ensureSuperStream(client, topicName(environment, 'reference'), { maxAge: '30D' });
    await ensureSuperStream(client, topicName(environment, 'market-data'), { maxAge: '30D' });
    const commandProducer = await PartitionedProducer.create(
      client,
      commands,
      `${d.config.SERVICE_NAME}.commands`,
    );
    relay = new OutboxRelay({
      db: d.db,
      listenConfig: d.database,
      producer: await PartitionedProducer.create(
        client,
        superStream,
        `${d.config.SERVICE_NAME}.outbox`,
      ),
      routes: { 'engine.phase_change': commandProducer, 'engine.band_update': commandProducer },
      clock: d.clock,
      onError: (err) => d.logger.error({ event: 'outbox.relay_failed', err }, 'falha no relay'),
    });
    const onError = (err: unknown) =>
      d.logger.error({ event: 'consumer.failed', err }, 'falha no consumidor');
    const base = { environment, stream: d.stream, db: d.db, newId: d.newId, onError };

    const applyCalendar = async (
      trx: Kysely<unknown>,
      e: { eventId: string; occurredAt: string; payload: unknown },
    ) => {
      await calendarReplica.apply(trx, {
        data: (e.payload as { calendar: CalendarData }).calendar,
        eventId: e.eventId,
        occurredAt: e.occurredAt,
      });
    };
    const applyInstrument = async (trx: Kysely<unknown>, e: { payload: unknown }) => {
      await session.onInstrumentState(
        store.tx(trx),
        e.payload as { instrumentId: string; symbol: string; tradable: boolean; status: string },
      );
    };
    consumers.push(
      new EventConsumer({
        ...base,
        // Cópia do cadastro: a ordem por instrumento importa (status antes de retomar).
        ordered: true,
        startFrom: 'first',
        name: 'session.reference',
        superStream: topicName(environment, 'reference'),
        handlers: {
          'calendar.updated': { definition: CalendarUpdatedV1, handle: applyCalendar },
          'session_schedule.updated': {
            definition: SessionScheduleUpdatedV1,
            handle: applyCalendar,
          },
          'instrument.created': { definition: InstrumentCreatedV1, handle: applyInstrument },
          'instrument.updated': { definition: InstrumentUpdatedV1, handle: applyInstrument },
          'instrument.status_changed': {
            definition: InstrumentStatusChangedV1,
            handle: async (trx, e) => {
              await session.onStatusChanged(
                store.tx(trx),
                e.payload as {
                  instrumentId: string;
                  symbol: string;
                  from: string;
                  to: string;
                  reason: string;
                },
              );
            },
          },
          'instrument.tradability_changed': {
            definition: InstrumentTradabilityChangedV1,
            handle: async (trx, e) => {
              await session.onTradabilityChanged(
                store.tx(trx),
                e.payload as { instrumentId: string; symbol: string; tradable: boolean },
              );
            },
          },
          'instrument.trading_rules_changed': {
            definition: InstrumentTradingRulesChangedV1,
            handle: async (trx, e) => {
              const p = e.payload as {
                ruleId: string;
                instrumentId: string | null;
                rules: Partial<SessionRules>;
                validFrom: string;
              };
              await session.onTradingRulesChanged(store.tx(trx), {
                ...p,
                validFrom: Instant.parse(p.validFrom),
              });
            },
          },
        },
      }),
    );
    consumers.push(
      new EventConsumer({
        ...base,
        ordered: false,
        name: 'session.scheduler',
        superStream: topicName(environment, 'scheduler'),
        handlers: {
          'routine.triggered': {
            definition: RoutineTriggeredV1,
            handle: async (trx, e) => {
              await session.onRoutine(
                store.tx(trx),
                e.payload as { routineName: string; businessDate: string; executionId: string },
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
    consumers.push(
      new EventConsumer({
        ...base,
        ordered: false,
        startFrom: 'next',
        name: 'session.market_data',
        superStream: topicName(environment, 'market-data'),
        handlers: {
          'market_data.external_quote_received': {
            definition: MarketDataExternalQuoteReceivedV1,
            handle: async (trx, e) => {
              const p = e.payload as {
                instrumentId: string | null;
                kind: 'INSTRUMENT' | 'INDEX';
                lastPrice: string;
                previousClose: string | null;
                quoteTime: string;
                stale: boolean;
              };
              const tx = store.tx(trx);
              const quoteTime = Instant.parse(p.quoteTime);
              if (p.kind === 'INDEX') await session.onIndexQuote(tx, { ...p, quoteTime });
              else if (p.instrumentId)
                await session.onInstrumentQuote(tx, {
                  ...p,
                  instrumentId: p.instrumentId,
                  quoteTime,
                });
              else await session.heartbeat(tx);
            },
          },
          'market_data.reference_price_updated': {
            definition: MarketDataReferencePriceUpdatedV1,
            handle: async (trx) => {
              await session.heartbeat(store.tx(trx));
            },
          },
          'market_data.provider_budget_level_changed': {
            definition: MarketDataProviderBudgetLevelChangedV1,
            handle: async (trx, e) => {
              await store.tx(trx).saveBudgetLevel((e.payload as { to: string }).to);
            },
          },
        },
      }),
    );
    consumers.push(
      new EventConsumer({
        ...base,
        // Saídas do Motor em ordem de `engine_seq` por instrumento (RN-ME-003).
        ordered: true,
        name: 'session.engine',
        superStream: topicName(environment, 'engine'),
        handlers: {
          'engine.auction_triggered': {
            definition: EngineAuctionTriggeredV1,
            handle: async (trx, e) => {
              await session.onAuctionTriggered(
                store.tx(trx),
                e.payload as {
                  instrumentId: string;
                  board: string;
                  auctionId: string;
                  expectedEndAt: string;
                },
              );
            },
          },
          'engine.auction_indicative': {
            definition: EngineAuctionIndicativeV1,
            handle: async (trx, e) => {
              await session.onAuctionIndicative(
                store.tx(trx),
                e.payload as {
                  board: string;
                  auctionId: string;
                  theoreticalPrice: string | null;
                  theoreticalQuantity: number;
                },
              );
            },
          },
          'engine.auction_completed': {
            definition: EngineAuctionCompletedV1,
            handle: async (trx, e) => {
              await session.onAuctionCompleted(
                store.tx(trx),
                e.payload as {
                  instrumentId: string;
                  board: string;
                  auctionId: string;
                  price: string | null;
                  quantity: number;
                },
              );
            },
          },
          'engine.trade_executed': {
            definition: EngineTradeExecutedV1,
            handle: async (trx, e) => {
              await session.onTradeExecuted(
                store.tx(trx),
                e.payload as {
                  instrumentId: string;
                  board: string;
                  engineSeq: number;
                  price: string;
                  tradingDate: string;
                  auctionId?: string;
                },
              );
            },
          },
          'engine.book_recovering': {
            definition: EngineBookRecoveringV1,
            handle: async (trx, e) => {
              await session.onBookRecovering(
                store.tx(trx),
                (e.payload as { instrumentId: string }).instrumentId,
              );
            },
          },
          'engine.book_recovered': {
            definition: EngineBookRecoveredV1,
            handle: async (trx, e) => {
              await session.onBookRecovered(
                store.tx(trx),
                (e.payload as { instrumentId: string }).instrumentId,
              );
            },
          },
        },
      }),
    );
  }

  let leader = false;
  const elector = new LeaderElector({
    database: d.database,
    name: 'trading-session',
    ...(d.leaderHeartbeatMs ? { heartbeatMs: d.leaderHeartbeatMs } : {}),
    onElected: () => {
      void (async () => {
        await relay?.start();
        leader = true;
        d.logger.info({ event: 'session.elected' }, 'sessão líder');
      })().catch((err: unknown) =>
        d.logger.error({ event: 'session.election_failed', err }, 'falha ao assumir'),
      );
    },
    onRevoked: (reason) => {
      leader = false;
      void relay?.stop();
      d.logger.warn({ event: 'session.revoked', reason }, 'sessão deixou de ser líder');
    },
    onError: (err) => d.logger.error({ event: 'session.leader_error', err }, 'falha na eleição'),
  });

  const service = createService({
    config: d.config,
    clock: d.clock,
    logger: d.logger,
    authenticator: d.authenticator,
    idempotency: new IdempotencyStore({ db: d.db }),
    readiness: { database: () => sql`SELECT 1`.execute(d.db) },
  });
  registerHttp(service, { queries, backoffice, sandboxCommands: d.sandboxCommands ?? false });

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  return {
    service,
    store,
    session,
    backoffice,
    queries,
    isLeader: () => leader,
    async start() {
      for (const c of consumers) await c.start();
      await elector.start();
      timer = setInterval(() => {
        if (running || !leader) return;
        running = true;
        void Promise.all([session.tick(), backoffice.expireDue()])
          .catch((err: unknown) =>
            d.logger.error({ event: 'session.worker_failed', err }, 'falha no laço de fundo'),
          )
          .finally(() => (running = false));
      }, d.loopIntervalMs ?? 1000);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      await elector.stop();
      leader = false;
      for (const c of consumers) await c.stop();
      await relay?.stop();
      await closeStream?.();
    },
  };
}
