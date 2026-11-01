import { TickedClock, type Clock } from '@broker/clock';
import { ClockTickedV1 } from '@broker/contracts/events/clock.ticked/v1';
import { EngineNotesCutoffV1 } from '@broker/contracts/events/engine.notes_cutoff/v1';
import { RoutineTriggeredV1 } from '@broker/contracts/events/routine.triggered/v1';
import {
  causedBy,
  connectStream,
  ensureSuperStream,
  EventConsumer,
  EventPublisher,
  OutboxRelay,
  PartitionedProducer,
  PartitionReader,
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
import { setTimeout as sleep } from 'node:timers/promises';
import { registerHttp } from './adapters/http.js';
import { OutputRelay } from './adapters/output-relay.js';
import { PostgresEngineStore } from './adapters/postgres-store.js';
import { EnginePartition, SEQUENCER_CONSUMER } from './application/partition.js';
import type { JournalEntry } from './application/ports.js';

/** Rotina a partir da qual não há mais trade bust no dia (RN-BST-001). */
const NOTES_ROUTINE = 'brokerage_notes';

export interface EngineServiceDeps {
  config: BaseConfig;
  db: Kysely<unknown>;
  database: DatabaseConfig;
  logger: Logger;
  clock: Clock;
  newId: () => string;
  newSeed: () => number;
  authenticator: Authenticator;
  stream: StreamSettings;
  partitions?: number;
  snapshotEveryInputs?: number;
  /** RN-REC-001: padrão de 5 minutos. */
  snapshotIntervalMs?: number;
  leaderHeartbeatMs?: number;
  /** Espera antes de voltar a disputar o lease depois de uma falha (padrão 1 s). */
  fatalBackoffMs?: number;
  /** Gancho de teste: simula a queda logo depois do journal. */
  afterJournal?: (entries: readonly JournalEntry[]) => void | Promise<void>;
}

/**
 * Monta o matching-engine (catálogo de serviços §9, D12). Cada partição de `engine.commands` tem o
 * próprio lease; a instância só lê uma partição depois de ganhar o lease dela e de recuperar os
 * livros, o que mantém um único escritor por livro mesmo se o broker e o banco discordarem.
 */
export async function createEngineService(d: EngineServiceDeps) {
  const environment = d.config.ENVIRONMENT;
  const source = d.config.SERVICE_NAME;
  const onError = (event: string) => (err: unknown) =>
    d.logger.error({ event, err }, 'falha no Motor');

  const environmentClock =
    d.clock instanceof TickedClock ? new EnvironmentClockReplica(d.db, d.clock) : undefined;
  await environmentClock?.restore();
  const publisher = new EventPublisher({
    source,
    environment,
    clock: d.clock,
    newId: d.newId,
  });
  const store = new PostgresEngineStore(d.db, publisher);

  const client = await connectStream(d.stream, source);
  const commands = topicName(environment, 'engine', 'commands');
  const events = topicName(environment, 'engine');
  // Retenções de RN-MSG-B-002.
  const partitionStreams = await ensureSuperStream(client, commands, {
    maxAge: '30D',
    ...(d.partitions ? { partitions: d.partitions } : {}),
  });
  await ensureSuperStream(client, events, {
    maxAge: '90D',
    ...(d.partitions ? { partitions: d.partitions } : {}),
  });
  await ensureSuperStream(client, topicName(environment, 'scheduler'), {
    partitions: 1,
    maxAge: '30D',
  });

  const eventsProducer = await PartitionedProducer.create(client, events, `${source}.output`);
  const outputRelay = new OutputRelay({
    db: d.db,
    producer: eventsProducer,
    source,
    environment,
    clock: d.clock,
    onError: onError('engine.relay_failed'),
  });
  // Controle fora de `engine_seq`: recuperação, snapshot e o corte das notas, que volta como comando.
  const controlRelay = new OutboxRelay({
    db: d.db,
    listenConfig: d.database,
    producer: await PartitionedProducer.create(client, events, `${source}.outbox`),
    routes: {
      'engine.notes_cutoff': await PartitionedProducer.create(
        client,
        commands,
        `${source}.commands`,
      ),
    },
    clock: d.clock,
    onError: onError('engine.outbox_failed'),
  });

  const relayElector = new LeaderElector({
    database: d.database,
    name: 'engine-relay',
    ...(d.leaderHeartbeatMs ? { heartbeatMs: d.leaderHeartbeatMs } : {}),
    onElected: () => {
      outputRelay.start();
      void controlRelay.start().catch(onError('engine.outbox_failed'));
    },
    onRevoked: () => {
      void outputRelay.stop();
      void controlRelay.stop();
    },
    onError: onError('engine.leader_error'),
  });

  // ---------------------------------------------------------------- partições

  const active = new Map<number, EnginePartition>();
  const recovering = new Set<number>();

  /** Dono de uma partição: reage ao lease, um passo de cada vez. */
  const runner = (index: number, streamName: string) => {
    let reader: PartitionReader | undefined;
    let partition: EnginePartition | undefined;
    let timers: NodeJS.Timeout[] = [];
    let queue: Promise<void> = Promise.resolve();
    let stopping = false;
    const inTurn = (step: () => Promise<void>) => {
      queue = queue.then(step).catch(onError('engine.partition_failed'));
      return queue;
    };

    const release = async () => {
      for (const t of timers) clearInterval(t);
      timers = [];
      await reader?.stop();
      reader = undefined;
      await partition?.stop();
      partition = undefined;
      active.delete(index);
    };

    const elector: LeaderElector = new LeaderElector({
      database: d.database,
      name: `engine-partition-${index}`,
      ...(d.leaderHeartbeatMs ? { heartbeatMs: d.leaderHeartbeatMs } : {}),
      onElected: () =>
        void inTurn(async () => {
          if (stopping) return;
          recovering.add(index);
          const p = new EnginePartition({
            partition: index,
            stream: streamName,
            environment,
            store,
            clock: d.clock,
            newId: d.newId,
            newSeed: d.newSeed,
            ...(d.snapshotEveryInputs ? { snapshotEveryInputs: d.snapshotEveryInputs } : {}),
            ...(d.afterJournal ? { afterJournal: d.afterJournal } : {}),
            onOutputs: () => outputRelay.wake(),
            onInvalid: (error) =>
              d.logger.error({ event: 'engine.command_invalid', error }, 'comando inválido'),
            // Algo saiu do previsto (ex.: outro líder gravou o mesmo `input_seq`): larga tudo, solta
            // o lease e volta a disputar, recuperando o estado do journal. A espera dá a vez a outra
            // instância e evita um laço quente se a falha se repetir.
            onFatal: (err) => {
              d.logger.error({ event: 'engine.partition_fatal', err }, 'partição derrubada');
              void inTurn(async () => {
                await release();
                await elector.stop();
                await sleep(d.fatalBackoffMs ?? 1000);
                if (!stopping) await elector.start();
              });
            },
          });
          const started = Date.now();
          const report = await p.recover();
          d.logger.info(
            {
              event: 'engine.partition_recovered',
              partition: index,
              ...report,
              ms: Date.now() - started,
            },
            'partição recuperada',
          );
          partition = p;
          active.set(index, p);
          recovering.delete(index);
          reader = new PartitionReader({
            name: SEQUENCER_CONSUMER,
            superStream: commands,
            partition: index,
            stream: d.stream,
            savedOffset: () => store.savedOffset(SEQUENCER_CONSUMER, streamName, index),
            onMessage: (raw, offset) => p.enqueue(raw, offset),
          });
          await reader.start();
          timers = [
            setInterval(() => p.tick(), 100),
            setInterval(
              () => void p.snapshotDue().catch(onError('engine.snapshot_failed')),
              d.snapshotIntervalMs ?? 300_000,
            ),
          ];
          for (const t of timers) t.unref();
        }),
      onRevoked: (reason) => {
        d.logger.warn(
          { event: 'engine.partition_revoked', partition: index, reason },
          'lease perdido',
        );
        void inTurn(release);
      },
      onError: onError('engine.leader_error'),
    });
    return {
      elector,
      stop: async () => {
        stopping = true;
        await elector.stop();
        await inTurn(async () => {
          await release();
          // Um `onFatal` já na fila pode ter religado o eleitor antes de ver `stopping`.
          await elector.stop();
          recovering.delete(index);
        });
      },
    };
  };

  const runners = partitionStreams.map((name) =>
    runner(Number(name.slice(commands.length + 1)), name),
  );

  // ---------------------------------------------------------------- relógio e rotinas

  const scheduler = new EventConsumer({
    environment,
    stream: d.stream,
    db: d.db,
    newId: d.newId,
    onError: onError('consumer.failed'),
    ordered: false,
    name: 'engine.scheduler',
    superStream: topicName(environment, 'scheduler'),
    handlers: {
      'routine.triggered': {
        definition: RoutineTriggeredV1,
        handle: async (trx, e) => {
          const p = e.payload as { routineName: string; businessDate: string };
          if (p.routineName !== NOTES_ROUTINE) return;
          for (const { instrumentId } of await store.allInstruments())
            await publisher.publish(
              trx,
              EngineNotesCutoffV1,
              { instrumentId, tradingDate: p.businessDate },
              causedBy(e, {
                partitionKey: instrumentId,
                aggregateType: 'engine',
                aggregateId: instrumentId,
                actor: { type: 'SYSTEM', id: source },
              }),
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
  });

  const service = createService({
    config: d.config,
    clock: d.clock,
    logger: d.logger,
    authenticator: d.authenticator,
    readiness: {
      database: () => sql`SELECT 1`.execute(d.db),
      // RN-REC-003: quem ainda está recuperando não está pronto.
      books: async () => {
        if (recovering.size > 0) throw new Error('livros em recuperação');
      },
    },
  });
  registerHttp(service, { store, partitions: () => [...active.values()] });

  return {
    service,
    store,
    partition: (index: number) => active.get(index),
    partitions: () => [...active.values()],
    async start() {
      await scheduler.start();
      await relayElector.start();
      for (const r of runners) await r.elector.start();
    },
    async stop() {
      for (const r of runners) await r.stop();
      await relayElector.stop();
      await outputRelay.stop();
      await controlRelay.stop();
      await scheduler.stop();
      await client.close().catch(() => undefined);
    },
  };
}
