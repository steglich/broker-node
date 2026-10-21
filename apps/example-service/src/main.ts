// Serviço de referência da Fase 0: mostra como um serviço é montado com o service-kit.
// POST /v1/pings grava o ping e o evento `example.pinged` na outbox (mesma transação); o relay
// publica no RabbitMQ; o consumidor marca o ping como processado. Com a telemetria ligada
// (`node --import @broker/service-kit/telemetry`), o caminho todo aparece num único trace.
import { RealClock } from '@broker/clock';
import { uuidv7 } from '@broker/ids';
import {
  connectStream,
  defineEvent,
  ensureSuperStream,
  EventConsumer,
  EventPublisher,
  OutboxRelay,
  PartitionedProducer,
  topicName,
} from '@broker/messaging';
import { createDatabase, inTransaction } from '@broker/persistence';
import {
  BaseConfigProperties,
  createLogger,
  createService,
  loadConfigOrExit,
  notFound,
} from '@broker/service-kit';
import { sql } from 'kysely';
import Type from 'typebox';

const Config = Type.Object({
  ...BaseConfigProperties,
  DB_HOST: Type.String(),
  DB_PORT: Type.Integer({ default: 5432 }),
  DB_NAME: Type.String(),
  DB_USER: Type.String(),
  DB_PASSWORD: Type.String(),
  STREAM_HOST: Type.String(),
  STREAM_PORT: Type.Integer({ default: 5552 }),
  STREAM_USER: Type.String(),
  STREAM_PASSWORD: Type.String(),
  /** Época do publisherRef do relay: troque depois de restaurar o banco (ADR-0001, achado 6). */
  OUTBOX_EPOCH: Type.String({ default: 'e1' }),
});

const config = loadConfigOrExit(Config);
const clock = new RealClock();
const logger = createLogger({
  service: config.SERVICE_NAME,
  environment: config.ENVIRONMENT,
  version: config.SERVICE_VERSION,
  level: config.LOG_LEVEL,
  clock,
});
const dbConfig = {
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
};
const db = createDatabase(dbConfig);
const stream = {
  host: config.STREAM_HOST,
  port: config.STREAM_PORT,
  user: config.STREAM_USER,
  password: config.STREAM_PASSWORD,
};

const Pinged = defineEvent({
  eventType: 'example.pinged',
  eventVersion: 1,
  payload: Type.Object({ pingId: Type.String({ format: 'uuid' }) }),
});
const SUPER_STREAM = topicName(config.ENVIRONMENT, 'example');

const client = await connectStream(stream, config.SERVICE_NAME);
await ensureSuperStream(client, SUPER_STREAM, { partitions: 3, maxAge: '7D' });
const publisher = new EventPublisher({
  source: config.SERVICE_NAME,
  environment: config.ENVIRONMENT,
  clock,
  newId: uuidv7,
});
const relay = new OutboxRelay({
  db,
  listenConfig: dbConfig,
  producer: await PartitionedProducer.create(
    client,
    SUPER_STREAM,
    `${config.SERVICE_NAME}.outbox.${config.OUTBOX_EPOCH}`,
  ),
  clock,
  onError: (err) => logger.error({ event: 'outbox.relay_failed', err }, 'falha no relay'),
});
const consumer = new EventConsumer({
  name: 'example.ping-processor',
  environment: config.ENVIRONMENT,
  superStream: SUPER_STREAM,
  stream,
  db,
  ordered: false,
  newId: uuidv7,
  onError: (err) => logger.error({ event: 'consumer.failed', err }, 'falha no consumidor'),
  handlers: {
    'example.pinged': {
      definition: Pinged,
      handle: async (trx, envelope) => {
        const { pingId } = envelope.payload as { pingId: string };
        await sql`UPDATE ping SET processed_at = ${clock.now().toString()} WHERE id = ${pingId}`.execute(
          trx,
        );
        logger.info({ event: 'example.ping_processed', ping_id: pingId }, 'ping processado');
      },
    },
  },
});

const service = createService({
  config,
  clock,
  logger,
  readiness: { database: () => sql`SELECT 1`.execute(db) },
});

service.route({
  method: 'post',
  path: '/v1/pings',
  auth: 'public',
  idempotent: false,
  handler: async (_req, ctx) => {
    const pingId = uuidv7();
    await inTransaction(db, async (trx) => {
      await sql`INSERT INTO ping (id, created_at) VALUES (${pingId}, ${ctx.requestedAt.toString()})`.execute(
        trx,
      );
      await publisher.publish(
        trx,
        Pinged,
        { pingId },
        {
          partitionKey: pingId,
          aggregateType: 'ping',
          aggregateId: pingId,
          actor: ctx.actor,
          correlationId: ctx.correlationId,
        },
      );
    });
    return { status: 202, body: { pingId } };
  },
});

service.route({
  method: 'get',
  path: '/v1/pings/:id',
  auth: 'public',
  validate: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }) },
  handler: async (req) => {
    const row = (
      await sql<{
        id: string;
        created_at: Date;
        processed_at: Date | null;
      }>`SELECT * FROM ping WHERE id = ${req.params.id}`.execute(db)
    ).rows[0];
    if (!row) throw notFound();
    return {
      body: {
        id: row.id,
        createdAt: row.created_at.toISOString(),
        processedAt: row.processed_at?.toISOString() ?? null,
      },
    };
  },
});

service.onShutdown('database', () => db.destroy());
service.onShutdown('stream', () => client.close());
service.onShutdown('relay', () => relay.stop());
service.onShutdown('consumer', () => consumer.stop());

await consumer.start();
await relay.start();
await service.start();
