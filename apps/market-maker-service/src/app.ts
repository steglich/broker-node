import { TickedClock, type Clock } from '@broker/clock';
import { ClockTickedV1 } from '@broker/contracts/events/clock.ticked/v1';
import { EngineAuctionCompletedV1 } from '@broker/contracts/events/engine.auction_completed/v1';
import { EngineBandUpdateV1 } from '@broker/contracts/events/engine.band_update/v1';
import { EngineBookChangedV1 } from '@broker/contracts/events/engine.book_changed/v1';
import { EngineOrderBookedV1 } from '@broker/contracts/events/engine.order_booked/v1';
import { EngineOrderCanceledV1 } from '@broker/contracts/events/engine.order_canceled/v1';
import { EngineOrderRejectedV1 } from '@broker/contracts/events/engine.order_rejected/v1';
import { EngineTradeBustedV1 } from '@broker/contracts/events/engine.trade_busted/v1';
import { EngineTradeExecutedV1 } from '@broker/contracts/events/engine.trade_executed/v1';
import { InstrumentCreatedV1 } from '@broker/contracts/events/instrument.created/v1';
import { InstrumentStatusChangedV1 } from '@broker/contracts/events/instrument.status_changed/v1';
import { InstrumentTradabilityChangedV1 } from '@broker/contracts/events/instrument.tradability_changed/v1';
import { InstrumentTradingRulesChangedV1 } from '@broker/contracts/events/instrument.trading_rules_changed/v1';
import { InstrumentUpdatedV1 } from '@broker/contracts/events/instrument.updated/v1';
import { MarketDataInstrumentStaleV1 } from '@broker/contracts/events/market_data.instrument_stale/v1';
import { MarketDataReferencePriceUpdatedV1 } from '@broker/contracts/events/market_data.reference_price_updated/v1';
import { SessionPhaseChangedV1 } from '@broker/contracts/events/session.phase_changed/v1';
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
import { EnvironmentClockReplica, LeaderElector, type DatabaseConfig } from '@broker/persistence';
import {
  createService,
  IdempotencyStore,
  type Authenticator,
  type BaseConfig,
  type Logger,
} from '@broker/service-kit';
import { sql, type Kysely } from 'kysely';
import { registerHttp } from './adapters/http.js';
import { PostgresSmmStore } from './adapters/postgres-store.js';
import { Backoffice } from './application/backoffice.js';
import { MarketMaker } from './application/market-maker.js';
import type { Phase } from './domain/phases.js';
import type { Side } from './domain/position.js';

/** A conta `MARKET_MAKER` do ambiente (RN-SMM-022): fixa, para o Clearing e a Custódia reconhecerem. */
export const DEFAULT_SMM_ACCOUNT_ID = '00000000-0000-7000-8000-00000000f115';

export interface SmmServiceDeps {
  config: BaseConfig;
  db: Kysely<unknown>;
  database: DatabaseConfig;
  logger: Logger;
  clock: Clock;
  newId: () => string;
  authenticator: Authenticator;
  accountId?: string;
  requestTtlHours?: number;
  stream?: StreamSettings;
  /** Intervalo do laço do líder (padrão 1 s). */
  loopIntervalMs?: number;
  leaderHeartbeatMs?: number;
}

/**
 * Monta o market-maker-service (catálogo de serviços §10). Ativo/passivo: só o líder roda a
 * manutenção e o relay da outbox; os consumidores são SAC e a linha do instrumento serializa todos.
 */
export async function createSmmService(d: SmmServiceDeps) {
  const environment = d.config.ENVIRONMENT;
  const environmentClock =
    d.clock instanceof TickedClock ? new EnvironmentClockReplica(d.db, d.clock) : undefined;
  await environmentClock?.restore();
  const publisher = new EventPublisher({
    source: d.config.SERVICE_NAME,
    environment,
    clock: d.clock,
    newId: d.newId,
  });
  const store = new PostgresSmmStore(d.db, publisher);
  const deps = {
    store,
    clock: d.clock,
    newId: d.newId,
    logger: d.logger,
    accountId: d.accountId ?? DEFAULT_SMM_ACCOUNT_ID,
    requestTtlHours: d.requestTtlHours ?? 24,
  };
  const maker = new MarketMaker(deps);
  const backoffice = new Backoffice(deps, maker);

  let relay: OutboxRelay | undefined;
  const consumers: EventConsumer[] = [];
  let closeStream: (() => Promise<void>) | undefined;
  if (d.stream) {
    const client = await connectStream(d.stream, d.config.SERVICE_NAME);
    closeStream = () => client.close();
    const superStream = topicName(environment, 'market-maker');
    const commands = topicName(environment, 'engine', 'commands');
    // A Custódia da Fase 3 relê `smm.instrument_activated` desde o início (RN-SMM-020).
    await ensureSuperStream(client, superStream, { maxAge: '365D' });
    await ensureSuperStream(client, commands, { maxAge: '30D' });
    await ensureSuperStream(client, topicName(environment, 'engine'), { maxAge: '90D' });
    await ensureSuperStream(client, topicName(environment, 'session'), { maxAge: '30D' });
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
      routes: { 'engine.new_order': commandProducer, 'engine.cancel_order': commandProducer },
      clock: d.clock,
      onError: (err) => d.logger.error({ event: 'outbox.relay_failed', err }, 'falha no relay'),
    });
    const onError = (err: unknown) =>
      d.logger.error({ event: 'consumer.failed', err }, 'falha no consumidor');
    // Tudo começa do início: um FMS novo reconstrói cadastro, fase, preço e livro do que já passou.
    const base = {
      environment,
      stream: d.stream,
      db: d.db,
      newId: d.newId,
      onError,
      ordered: true,
      startFrom: 'first' as const,
    };

    const applyInstrument = async (trx: Kysely<unknown>, e: { payload: unknown }) => {
      await maker.onInstrumentState(
        store.tx(trx),
        e.payload as {
          instrumentId: string;
          symbol: string;
          lotSize: number;
          tickSize: string;
          oddLotEnabled: boolean;
          tradable: boolean;
          status: string;
        },
      );
    };
    consumers.push(
      new EventConsumer({
        ...base,
        name: 'smm.reference',
        superStream: topicName(environment, 'reference'),
        handlers: {
          'instrument.created': { definition: InstrumentCreatedV1, handle: applyInstrument },
          'instrument.updated': { definition: InstrumentUpdatedV1, handle: applyInstrument },
          'instrument.tradability_changed': {
            definition: InstrumentTradabilityChangedV1,
            handle: async (trx, e) => {
              await maker.onTradabilityChanged(
                store.tx(trx),
                e.payload as {
                  instrumentId: string;
                  symbol: string;
                  lotSize: number;
                  tradable: boolean;
                },
              );
            },
          },
          'instrument.status_changed': {
            definition: InstrumentStatusChangedV1,
            handle: async (trx, e) => {
              await maker.onStatusChanged(
                store.tx(trx),
                e.payload as { instrumentId: string; to: string },
              );
            },
          },
          'instrument.trading_rules_changed': {
            definition: InstrumentTradingRulesChangedV1,
            handle: async (trx, e) => {
              const p = e.payload as {
                ruleId: string;
                instrumentId: string | null;
                rules: { smmSpreadBps?: number };
                validFrom: string;
              };
              await maker.onTradingRulesChanged(store.tx(trx), {
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
        name: 'smm.session',
        superStream: topicName(environment, 'session'),
        handlers: {
          'session.phase_changed': {
            definition: SessionPhaseChangedV1,
            handle: async (trx, e) => {
              await maker.onPhaseChanged(store.tx(trx), e.payload as { scope: string; to: Phase });
            },
          },
        },
      }),
    );
    consumers.push(
      new EventConsumer({
        ...base,
        name: 'smm.market_data',
        superStream: topicName(environment, 'market-data'),
        handlers: {
          'market_data.reference_price_updated': {
            definition: MarketDataReferencePriceUpdatedV1,
            handle: async (trx, e) => {
              const p = e.payload as {
                instrumentId: string;
                seq: number;
                price: string;
                externalQuoteTime: string | null;
              };
              await maker.onReferencePrice(store.tx(trx), {
                ...p,
                externalQuoteTime: p.externalQuoteTime ? Instant.parse(p.externalQuoteTime) : null,
              });
            },
          },
          'market_data.instrument_stale': {
            definition: MarketDataInstrumentStaleV1,
            handle: async (trx, e) => {
              const p = e.payload as { instrumentId: string; staleSince: string };
              await maker.onInstrumentStale(store.tx(trx), {
                instrumentId: p.instrumentId,
                staleSince: Instant.parse(p.staleSince),
                declaredAt: Instant.parse(e.occurredAt),
              });
            },
          },
        },
      }),
    );
    const orderGone = async (trx: Kysely<unknown>, e: { payload: unknown }) => {
      await maker.onOrderGone(
        store.tx(trx),
        e.payload as { instrumentId: string; orderId: string },
      );
    };
    consumers.push(
      new EventConsumer({
        ...base,
        // Saídas do Motor em ordem de `engine_seq` por instrumento (RN-ME-003).
        name: 'smm.engine',
        superStream: topicName(environment, 'engine'),
        handlers: {
          'engine.order_booked': {
            definition: EngineOrderBookedV1,
            handle: async (trx, e) => {
              await maker.onOrderBooked(
                store.tx(trx),
                e.payload as { instrumentId: string; orderId: string; remainingQuantity: number },
              );
            },
          },
          'engine.order_canceled': { definition: EngineOrderCanceledV1, handle: orderGone },
          'engine.order_rejected': { definition: EngineOrderRejectedV1, handle: orderGone },
          'engine.trade_executed': {
            definition: EngineTradeExecutedV1,
            handle: async (trx, e) => {
              await maker.onTradeExecuted(
                store.tx(trx),
                e.payload as Parameters<MarketMaker['onTradeExecuted']>[1],
              );
            },
          },
          'engine.trade_busted': {
            definition: EngineTradeBustedV1,
            handle: async (trx, e) => {
              await maker.onTradeBusted(
                store.tx(trx),
                e.payload as { instrumentId: string; tradeId: string },
              );
            },
          },
          'engine.book_changed': {
            definition: EngineBookChangedV1,
            handle: async (trx, e) => {
              await maker.onBookChanged(
                store.tx(trx),
                e.payload as {
                  instrumentId: string;
                  board: string;
                  engineSeq: number;
                  side: Side;
                  price: string;
                  newQuantity: number;
                },
              );
            },
          },
          'engine.auction_completed': {
            definition: EngineAuctionCompletedV1,
            handle: async (trx, e) => {
              await maker.onAuctionCompleted(
                store.tx(trx),
                e.payload as { instrumentId: string; board: string; price: string | null },
              );
            },
          },
        },
      }),
    );
    consumers.push(
      new EventConsumer({
        ...base,
        // O Motor não publica o túnel: lê o mesmo `BandUpdate` que ele recebe (RN-SMM-002).
        name: 'smm.band',
        superStream: commands,
        handlers: {
          'engine.band_update': {
            definition: EngineBandUpdateV1,
            handle: async (trx, e) => {
              await maker.onBandUpdate(
                store.tx(trx),
                e.payload as {
                  instrumentId: string;
                  bandReferencePrice: string;
                  rejectionBandPct: string;
                },
              );
            },
          },
        },
      }),
    );
    if (environmentClock)
      consumers.push(
        new EventConsumer({
          ...base,
          ordered: false,
          startFrom: 'next',
          name: 'smm.scheduler',
          superStream: topicName(environment, 'scheduler'),
          handlers: {
            'clock.ticked': {
              definition: ClockTickedV1,
              handle: async (trx, e) => {
                await environmentClock.apply(trx, e.payload as { virtualNow: string });
              },
            },
          },
        }),
      );
  }

  let leader = false;
  const elector = new LeaderElector({
    database: d.database,
    name: 'market-maker',
    ...(d.leaderHeartbeatMs ? { heartbeatMs: d.leaderHeartbeatMs } : {}),
    onElected: () => {
      void (async () => {
        await relay?.start();
        leader = true;
        d.logger.info({ event: 'smm.elected' }, 'FMS líder');
      })().catch((err: unknown) =>
        d.logger.error({ event: 'smm.election_failed', err }, 'falha ao assumir'),
      );
    },
    onRevoked: (reason) => {
      leader = false;
      void relay?.stop();
      d.logger.warn({ event: 'smm.revoked', reason }, 'FMS deixou de ser líder');
    },
    onError: (err) => d.logger.error({ event: 'smm.leader_error', err }, 'falha na eleição'),
  });

  const service = createService({
    config: d.config,
    clock: d.clock,
    logger: d.logger,
    authenticator: d.authenticator,
    idempotency: new IdempotencyStore({ db: d.db }),
    readiness: { database: () => sql`SELECT 1`.execute(d.db) },
  });
  registerHttp(service, { backoffice });

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  return {
    service,
    store,
    maker,
    backoffice,
    accountId: deps.accountId,
    isLeader: () => leader,
    async start() {
      for (const c of consumers) await c.start();
      await elector.start();
      timer = setInterval(() => {
        if (running || !leader) return;
        running = true;
        void Promise.all([maker.tick(), backoffice.expireDue()])
          .catch((err: unknown) =>
            d.logger.error({ event: 'smm.worker_failed', err }, 'falha no laço de fundo'),
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
