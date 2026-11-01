import { TickedClock, type Clock } from '@broker/clock';
import { AccountOpenedV1 } from '@broker/contracts/events/account.opened/v1';
import { AccountStatusChangedV1 } from '@broker/contracts/events/account.status_changed/v1';
import { ClockTickedV1 } from '@broker/contracts/events/clock.ticked/v1';
import { EngineTradeBustedV1 } from '@broker/contracts/events/engine.trade_busted/v1';
import { EngineTradeExecutedV1 } from '@broker/contracts/events/engine.trade_executed/v1';
import { LedgerBalanceChangedV1 } from '@broker/contracts/events/ledger.balance_changed/v1';
import { LedgerJournalPostedV1 } from '@broker/contracts/events/ledger.journal_posted/v1';
import { MarketDataReferencePriceUpdatedV1 } from '@broker/contracts/events/market_data.reference_price_updated/v1';
import { OrderCanceledV1 } from '@broker/contracts/events/order.canceled/v1';
import { OrderExpiredV1 } from '@broker/contracts/events/order.expired/v1';
import { OrderRejectedV1 } from '@broker/contracts/events/order.rejected/v1';
import { OrderUpdatedV1 } from '@broker/contracts/events/order.updated/v1';
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
  type StreamSettings,
} from '@broker/messaging';
import { EnvironmentClockReplica, LeaderElector, type DatabaseConfig } from '@broker/persistence';
import {
  createService,
  type Authenticator,
  type BaseConfig,
  type Logger,
} from '@broker/service-kit';
import { sql, type Kysely } from 'kysely';
import { registerHttp } from './adapters/http.js';
import { PostgresRiskStore } from './adapters/postgres-store.js';
import type { RiskDeps } from './application/context.js';
import { Decisions } from './application/decisions.js';
import { RiskMemory } from './application/memory.js';
import type { OrphanHoldAlert } from './application/ports.js';
import { Projector } from './application/projector.js';

/** RN-HLD-007: a reconciliação dos holds órfãos. */
const RECONCILE_EVERY_MS = 5 * 60_000;

export interface RiskServiceDeps {
  config: BaseConfig;
  db: Kysely<unknown>;
  database: DatabaseConfig;
  logger: Logger;
  clock: Clock;
  newId: () => string;
  authenticator: Authenticator;
  stream?: StreamSettings;
  onAlert?: (alert: OrphanHoldAlert) => void;
  /** Intervalo do laço do líder (padrão 1 s): é o throttle de `risk.buying_power_changed`. */
  loopIntervalMs?: number;
  leaderHeartbeatMs?: number;
}

/**
 * Monta o risk-service (catálogo de serviços §8, D13). Ativo/passivo: a instância eleita carrega a
 * projeção, consome os eventos e decide; a outra fica sem `readiness` até assumir.
 */
export async function createRiskService(d: RiskServiceDeps) {
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
  const store = new PostgresRiskStore(d.db, publisher);
  const memory = new RiskMemory();
  const deps: RiskDeps = {
    store,
    memory,
    clock: d.clock,
    newId: d.newId,
    logger: d.logger,
    ...(d.onAlert ? { onAlert: d.onAlert } : {}),
  };
  const projector = new Projector(deps);
  const decisions = new Decisions(deps);

  let relay: OutboxRelay | undefined;
  const consumers: EventConsumer[] = [];
  /** Partições a alcançar antes de aprovar (RN-RSK Recuperação): consumidor, stream e partição. */
  let lastOffsets: () => Promise<
    { consumer: string; stream: string; partition: number; offset: bigint }[]
  > = () => Promise.resolve([]);
  let closeStream: (() => Promise<void>) | undefined;
  if (d.stream) {
    const client = await connectStream(d.stream, d.config.SERVICE_NAME);
    closeStream = () => client.close();
    const superStream = topicName(environment, 'risk');
    // risk.events: 90 dias (Mensageria, Diretrizes §2).
    await ensureSuperStream(client, superStream, { maxAge: '90D' });
    const ledger = topicName(environment, 'ledger');
    const engine = topicName(environment, 'engine');
    const oms = topicName(environment, 'oms');
    const customer = topicName(environment, 'customer');
    const marketData = topicName(environment, 'market-data');
    await ensureSuperStream(client, ledger, { maxAge: '90D' });
    await ensureSuperStream(client, engine, { maxAge: '90D' });
    await ensureSuperStream(client, oms, { maxAge: '90D' });
    await ensureSuperStream(client, customer, { maxAge: '30D' });
    await ensureSuperStream(client, marketData, { maxAge: '30D' });
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
    // Tudo começa do início: um Risco novo reconstrói a projeção do que já passou.
    const base = {
      environment,
      stream: d.stream,
      db: d.db,
      newId: d.newId,
      onError,
      ordered: true,
      startFrom: 'first' as const,
    };
    const withdrawalClosed =
      (status: string) => async (trx: Kysely<unknown>, e: { payload: unknown }) => {
        await projector.onWithdrawalClosed(
          store.tx(trx),
          e.payload as { withdrawalId: string; accountId: string },
          status,
        );
      };
    consumers.push(
      new EventConsumer({
        ...base,
        name: 'risk.ledger',
        superStream: ledger,
        handlers: {
          'ledger.journal_posted': {
            definition: LedgerJournalPostedV1,
            handle: async (trx, e) => {
              await projector.onJournalPosted(
                store.tx(trx),
                e.payload as unknown as Parameters<Projector['onJournalPosted']>[1],
              );
            },
          },
          'ledger.balance_changed': {
            definition: LedgerBalanceChangedV1,
            handle: async (trx, e) => {
              await projector.onBalanceChanged(
                store.tx(trx),
                e.payload as unknown as Parameters<Projector['onBalanceChanged']>[1],
              );
            },
          },
          'withdrawal.completed': {
            definition: WithdrawalCompletedV1,
            handle: withdrawalClosed('COMPLETED'),
          },
          'withdrawal.failed': {
            definition: WithdrawalFailedV1,
            handle: withdrawalClosed('FAILED'),
          },
          'withdrawal.rejected': {
            definition: WithdrawalRejectedV1,
            handle: withdrawalClosed('REJECTED'),
          },
        },
      }),
      new EventConsumer({
        ...base,
        name: 'risk.engine',
        superStream: engine,
        handlers: {
          'engine.trade_executed': {
            definition: EngineTradeExecutedV1,
            handle: async (trx, e) => {
              await projector.onTradeExecuted(
                store.tx(trx),
                e.payload as unknown as Parameters<Projector['onTradeExecuted']>[1],
              );
            },
          },
          'engine.trade_busted': {
            definition: EngineTradeBustedV1,
            handle: async (trx, e) => {
              await projector.onTradeBusted(store.tx(trx), e.payload as { tradeId: string });
            },
          },
        },
      }),
      new EventConsumer({
        ...base,
        name: 'risk.oms',
        superStream: oms,
        handlers: {
          'order.updated': {
            definition: OrderUpdatedV1,
            handle: async (trx, e) => {
              await projector.onOrderUpdated(
                store.tx(trx),
                e.payload as { orderId: string; accountId: string; status: string },
              );
            },
          },
          'order.canceled': {
            definition: OrderCanceledV1,
            handle: async (trx, e) => {
              await projector.onOrderClosed(
                store.tx(trx),
                e.payload as { orderId: string; accountId: string; canceledQuantity: number },
                'CANCELED',
              );
            },
          },
          'order.expired': {
            definition: OrderExpiredV1,
            handle: async (trx, e) => {
              await projector.onOrderClosed(
                store.tx(trx),
                e.payload as { orderId: string; accountId: string; canceledQuantity: number },
                'EXPIRED',
              );
            },
          },
          'order.rejected': {
            definition: OrderRejectedV1,
            handle: async (trx, e) => {
              await projector.onOrderRejected(
                store.tx(trx),
                e.payload as { orderId: string; accountId: string },
              );
            },
          },
        },
      }),
      new EventConsumer({
        ...base,
        name: 'risk.customer',
        superStream: customer,
        handlers: {
          'account.opened': {
            definition: AccountOpenedV1,
            handle: async (trx, e) => {
              await projector.onAccountStatus(
                store.tx(trx),
                (e.payload as { accountId: string }).accountId,
                'ACTIVE',
              );
            },
          },
          'account.status_changed': {
            definition: AccountStatusChangedV1,
            handle: async (trx, e) => {
              const p = e.payload as { accountId: string; to: string };
              await projector.onAccountStatus(store.tx(trx), p.accountId, p.to);
            },
          },
        },
      }),
      new EventConsumer({
        ...base,
        ordered: false,
        name: 'risk.market_data',
        superStream: marketData,
        handlers: {
          'market_data.reference_price_updated': {
            definition: MarketDataReferencePriceUpdatedV1,
            handle: async (trx, e) => {
              await projector.onReferencePrice(
                store.tx(trx),
                e.payload as { instrumentId: string; price: string; seq: number },
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
          name: 'risk.scheduler',
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
    lastOffsets = async () => {
      const targets = [];
      for (const c of consumers.filter((x) => x.name !== 'risk.scheduler')) {
        const stream = c.superStream;
        for (const partitionStream of await client.partitionsQuery({ superStream: stream })) {
          const stats = await client.streamStatsRequest(partitionStream).catch(() => null);
          if (!stats || stats.lastChunkId < 0n) continue; // partição vazia: nada a alcançar
          targets.push({
            consumer: c.name,
            stream,
            partition: Number(partitionStream.slice(stream.length + 1)),
            offset: stats.lastChunkId,
          });
        }
      }
      return targets;
    };
  }

  /** Só aprova depois de alcançar o que já estava nos tópicos ao assumir (RNF-022, Cache §2). */
  const caughtUp = async (
    targets: Awaited<ReturnType<typeof lastOffsets>>,
    current: () => boolean,
  ) => {
    let pending = targets;
    while (pending.length > 0 && current()) {
      const { rows } = await sql<{
        consumer: string;
        stream: string;
        partition: number;
        offset: bigint;
      }>`
        SELECT consumer, stream, partition, "offset" FROM consumer_offset`.execute(d.db);
      const saved = new Map(
        rows.map((r) => [`${r.consumer}|${r.stream}|${r.partition}`, r.offset]),
      );
      pending = pending.filter(
        (t) => (saved.get(`${t.consumer}|${t.stream}|${t.partition}`) ?? -1n) < t.offset,
      );
      if (pending.length > 0) await new Promise((r) => setTimeout(r, 100));
    }
  };

  // Reage à liderança um passo de cada vez: um `revoke` nunca passa na frente da carga.
  let turn: Promise<void> = Promise.resolve();
  let generation = 0;
  let leading = false;
  let rebuilding = true;
  const inTurn = (step: () => Promise<void>) => {
    turn = turn
      .then(step)
      .catch((err: unknown) =>
        d.logger.error({ event: 'risk.leadership_failed', err }, 'falha ao trocar de papel'),
      );
    return turn;
  };

  const release = async () => {
    decisions.close();
    leading = false;
    rebuilding = true;
    for (const c of consumers) await c.stop();
    await relay?.stop();
  };

  const elector = new LeaderElector({
    database: d.database,
    name: 'risk',
    ...(d.leaderHeartbeatMs ? { heartbeatMs: d.leaderHeartbeatMs } : {}),
    onElected: () => {
      const mine = ++generation;
      void inTurn(async () => {
        const started = Date.now();
        await environmentClock?.restore();
        // A época sobe antes da carga: o líder antigo não grava mais nada que a carga não veja.
        const epoch = await store.bumpEpoch();
        const loaded = await store.loadAll();
        memory.reset(loaded.accounts, loaded.prices);
        leading = true;
        await relay?.start();
        const targets = await lastOffsets();
        for (const c of consumers) await c.start();
        await caughtUp(targets, () => generation === mine);
        if (generation !== mine) return;
        rebuilding = false;
        decisions.open(epoch);
        d.logger.info(
          { event: 'risk.ready', accounts: memory.size(), ms: Date.now() - started },
          'projeção reconstruída',
        );
      });
    },
    onRevoked: (reason) => {
      generation++;
      decisions.close();
      d.logger.warn({ event: 'risk.revoked', reason }, 'Risco deixou de ser líder');
      void inTurn(release);
    },
    onError: (err) => d.logger.error({ event: 'risk.leader_error', err }, 'falha na eleição'),
  });

  const service = createService({
    config: d.config,
    clock: d.clock,
    logger: d.logger,
    authenticator: d.authenticator,
    readiness: {
      database: () => sql`SELECT 1`.execute(d.db),
      // Cache e retenção §2: em espera ou reconstruindo, não está pronto.
      projection: async () => {
        if (rebuilding || !decisions.isOpen()) throw new Error('projeção em reconstrução');
      },
    },
  });
  registerHttp(service, { decisions });

  let lastReconciliation = d.clock.now();
  /** Uma rodada do trabalho de fundo do líder. */
  const work = async () => {
    await decisions.publishBuyingPower();
    const now = d.clock.now();
    if (now.epochMillis - lastReconciliation.epochMillis >= RECONCILE_EVERY_MS) {
      lastReconciliation = now;
      await decisions.reconcileOrphans();
    }
  };

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  return {
    service,
    store,
    memory,
    projector,
    decisions,
    work,
    isLeading: () => leading,
    isReady: () => !rebuilding && decisions.isOpen(),
    async start() {
      await elector.start();
      timer = setInterval(() => {
        if (running || !decisions.isOpen()) return;
        running = true;
        void work()
          .catch((err: unknown) =>
            d.logger.error({ event: 'risk.worker_failed', err }, 'falha no laço de fundo'),
          )
          .finally(() => (running = false));
      }, d.loopIntervalMs ?? 1000);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      generation++;
      await elector.stop();
      await inTurn(release);
      await closeStream?.();
    },
  };
}
