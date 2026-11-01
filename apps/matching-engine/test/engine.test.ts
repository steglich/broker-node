// De ponta a ponta com PostgreSQL e RabbitMQ reais: comando em `engine.commands` → journal → saída em
// `engine_output` → `engine.events`, incluindo as quedas (RN-ME-003/004, RN-REC-*, RNF-031, RNF-022).
import { EngineNewOrderV1 } from '@broker/contracts/events/engine.new_order/v1';
import { EnginePhaseChangeV1 } from '@broker/contracts/events/engine.phase_change/v1';
import { RoutineTriggeredV1 } from '@broker/contracts/events/routine.triggered/v1';
import { uuidv7 } from '@broker/ids';
import {
  connectStream,
  ensureSuperStream,
  PartitionedProducer,
  partitionIndex,
  topicName,
  type Envelope,
  type StreamSettings,
} from '@broker/messaging';
import { createDatabase, migrateToLatest, type DatabaseConfig } from '@broker/persistence';
import { Authenticator, createLogger } from '@broker/service-kit';
import { testClock, waitUntil } from '@broker/testing';
import {
  databaseConfig,
  startPostgres,
  startRabbitMq,
  type StartedPostgres,
  type StartedRabbitMq,
} from '@broker/testing/containers';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { sql, type Kysely } from 'kysely';
import { Offset, type Client } from 'rabbitmq-stream-js-client';
import { Writable } from 'node:stream';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEngineService, type EngineServiceDeps } from '../src/app.js';
import { InstrumentEngine } from '../src/domain/engine.js';
import type { EngineInput } from '../src/domain/inputs.js';
import { migrations } from '../src/migrations.js';

const ISSUER = 'https://auth.broker.test';
const AUDIENCE = 'broker-api';
const ENV = 'test';

let pg: StartedPostgres;
let rabbit: StartedRabbitMq;
let db: Kysely<unknown>;
let owner: Kysely<unknown>;
let database: DatabaseConfig;
let stream: StreamSettings;
let client: Client;
let commands: PartitionedProducer;
let publishingId = 1n;
let jwk: JWK;
let signingKey: CryptoKey;

const clock = testClock({ date: '2026-03-03', time: '10:00' });
const silent = () => new Writable({ write: (_c, _e, cb) => cb() });

beforeAll(async () => {
  [pg, rabbit] = await Promise.all([startPostgres(['matching_engine']), startRabbitMq()]);
  owner = createDatabase(databaseConfig(pg, 'matching_engine', 'migrator'));
  await migrateToLatest(owner, migrations);
  database = databaseConfig(pg, 'matching_engine', 'app');
  db = createDatabase(database);
  stream = {
    host: rabbit.host,
    port: rabbit.streamPort,
    user: rabbit.user,
    password: rabbit.password,
    amqpPort: rabbit.amqpPort,
  };
  client = await connectStream(stream, 'test');
  await ensureSuperStream(client, topicName(ENV, 'engine', 'commands'), { partitions: 2 });
  await ensureSuperStream(client, topicName(ENV, 'engine'), { partitions: 2 });
  await ensureSuperStream(client, topicName(ENV, 'scheduler'), { partitions: 1 });
  commands = await PartitionedProducer.create(client, topicName(ENV, 'engine', 'commands'), 'test');
  const pair = await generateKeyPair('ES256', { extractable: true });
  signingKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' };
}, 240_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await db?.destroy();
  await owner?.destroy();
  await Promise.all([pg?.container.stop(), rabbit?.container.stop()]);
});

async function bearer(roles: string[]) {
  const now = Math.floor(clock.now().epochMillis / 1000);
  const token = await new SignJWT({
    realm: 'backoffice',
    roles,
    scope: 'backoffice',
    session_id: 's-op',
    amr: ['pwd', 'otp'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
    .setSubject(uuidv7())
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(signingKey);
  return { Authorization: `Bearer ${token}` };
}

type Deps = Partial<EngineServiceDeps>;

/** Uma instância esquecida seguraria os leases e travaria os testes seguintes. */
const running: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((stop) => stop()));
});

async function engine(overrides: Deps = {}) {
  const logger = createLogger({
    service: 'matching-engine',
    environment: ENV,
    version: '0',
    level: 'fatal',
    clock,
    destination: silent(),
  });
  const app = await createEngineService({
    config: {
      SERVICE_NAME: 'matching-engine',
      SERVICE_VERSION: '0',
      GIT_COMMIT: 'x',
      ENVIRONMENT: ENV,
      PORT: 0,
      LOG_LEVEL: 'fatal',
      SHUTDOWN_TIMEOUT_MS: 0,
    },
    db,
    database,
    logger,
    clock,
    newId: uuidv7,
    newSeed: () => 42,
    authenticator: new Authenticator({
      jwks: createLocalJWKSet({ keys: [jwk] }),
      issuer: ISSUER,
      audience: AUDIENCE,
      clock,
    }),
    stream,
    partitions: 2,
    leaderHeartbeatMs: 100,
    fatalBackoffMs: 50,
    ...overrides,
  });
  await app.start();
  let stopped: Promise<void> | undefined;
  const stop = () => (stopped ??= app.stop());
  running.push(stop);
  return { ...app, stop };
}

async function send(eventType: string, payload: Record<string, unknown>, partitionKey: string) {
  const eventId = uuidv7();
  const envelope: Envelope = {
    eventId,
    eventType,
    eventVersion: 1,
    source: 'test',
    environment: ENV,
    occurredAt: clock.now().toString(),
    partitionKey,
    correlationId: `corr-${eventId}`,
    actor: { type: 'SYSTEM', id: 'test' },
    auditable: false,
    payload,
  };
  await commands.sendAll([
    {
      partitionKey,
      publishingId: publishingId++,
      messageId: eventId,
      body: Buffer.from(JSON.stringify(envelope)),
    },
  ]);
  return { eventId, envelope };
}

const phase = (instrumentId: string, target: string) =>
  send(EnginePhaseChangeV1.eventType, { scope: instrumentId, phase: target }, instrumentId);

const newOrder = (
  instrumentId: string,
  side: 'BUY' | 'SELL',
  quantity: number,
  limitPrice: string,
  orderId = uuidv7(),
) =>
  send(
    EngineNewOrderV1.eventType,
    {
      instrumentId,
      orderId,
      accountId: uuidv7(),
      participantType: 'CUSTOMER',
      board: 'MAIN',
      side,
      type: 'LIMIT',
      quantity,
      limitPrice,
      timeInForce: 'DAY',
      stpPolicy: 'CANCEL_AGGRESSOR',
    },
    instrumentId,
  );

const journalCount = async (id: string) =>
  Number(
    (
      await sql<{
        n: string;
      }>`SELECT count(*) AS n FROM engine_journal WHERE instrument_id = ${id}`.execute(db)
    ).rows[0]!.n,
  );

const outputs = async (id: string) =>
  (
    await sql<{
      board: string;
      engine_seq: string;
      event_type: string;
      event_id: string;
      payload: Record<string, unknown>;
      published_at: Date | null;
    }>`SELECT board, engine_seq, event_type, event_id, payload, published_at FROM engine_output
       WHERE instrument_id = ${id} ORDER BY board, engine_seq`.execute(db)
  ).rows;

/** Tudo o que saiu em `engine.events`, do início. */
async function published(id: string, type?: string) {
  const seen: Envelope[] = [];
  const reader = await connectStream(stream, `reader-${uuidv7()}`);
  const partitions = await reader.partitionsQuery({ superStream: topicName(ENV, 'engine') });
  for (const partition of partitions)
    await reader.declareConsumer({ stream: partition, offset: Offset.first() }, (m) => {
      const e = JSON.parse((m.content as Buffer).toString()) as Envelope;
      if (e.partitionKey === id && (!type || e.eventType === type)) seen.push(e);
    });
  return {
    seen,
    close: () => reader.close().catch(() => undefined),
  };
}

beforeEach(() => {
  clock.advanceTo(clock.now().plusMillis(1000));
});

describe('matching-engine', () => {
  it('do comando ao evento publicado, com sequências contínuas e a correlação preservada', async () => {
    const app = await engine();
    const id = uuidv7();
    await phase(id, 'CONTINUOUS');
    await newOrder(id, 'SELL', 100, '10.00');
    const buy = await newOrder(id, 'BUY', 100, '10.00');

    await waitUntil(async () => (await outputs(id)).some((o) => o.published_at !== null));
    await waitUntil(async () => (await outputs(id)).every((o) => o.published_at !== null));

    const rows = await outputs(id);
    expect(rows.map((r) => Number(r.engine_seq))).toEqual(rows.map((_, i) => i + 1));

    const reader = await published(id, 'engine.trade_executed');
    await waitUntil(() => reader.seen.length === 1);
    const trade = reader.seen[0]!;
    expect(trade.source).toBe('matching-engine');
    expect(trade.causationId).toBe(buy.eventId);
    expect(trade.correlationId).toBe(buy.envelope.correlationId);
    expect(trade.payload).toMatchObject({ instrumentId: id, price: '10.00', quantity: 100 });
    await reader.close();
    await app.stop();
  });

  it('um comando reenviado com outro offset não entra de novo no journal (RN-ME-003)', async () => {
    const app = await engine();
    const id = uuidv7();
    const first = await phase(id, 'CONTINUOUS');
    await commands.sendAll([
      {
        partitionKey: id,
        publishingId: publishingId++,
        messageId: first.eventId,
        body: Buffer.from(JSON.stringify(first.envelope)),
      },
    ]);
    await newOrder(id, 'BUY', 100, '9.00');
    await waitUntil(async () => (await journalCount(id)) >= 2);
    await app.partitions()[0]?.idle();
    expect(await journalCount(id)).toBe(2);
    await app.stop();
  });

  it('comando inválido vai para a dead_letter sem travar a partição', async () => {
    const app = await engine();
    const id = uuidv7();
    await send(EngineNewOrderV1.eventType, { instrumentId: id, quantity: -1 }, id);
    await phase(id, 'CONTINUOUS');
    await waitUntil(async () => (await journalCount(id)) === 1);
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM dead_letter WHERE consumer = 'engine.sequencer'`.execute(db);
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(1);
    await app.stop();
  });

  it('queda depois do journal: a entrada é processada na recuperação (RNF-031)', async () => {
    const id = uuidv7();
    let crash = false;
    let atCrash: { journal: number; trades: number } | undefined;
    const app = await engine({
      afterJournal: async (entries) => {
        if (!crash || !entries.some((e) => e.instrumentId === id)) return;
        crash = false;
        // Gravada e ainda sem negócio: é este o ponto em que o processo cai.
        atCrash = {
          journal: await journalCount(id),
          trades: (await outputs(id)).filter((o) => o.event_type === 'engine.trade_executed')
            .length,
        };
        throw new Error('queda simulada');
      },
    });
    await phase(id, 'CONTINUOUS');
    await newOrder(id, 'SELL', 100, '10.00');
    await waitUntil(async () => (await outputs(id)).length >= 2);

    crash = true;
    await newOrder(id, 'BUY', 100, '10.00');
    await waitUntil(() => atCrash !== undefined);
    expect(atCrash).toEqual({ journal: 3, trades: 0 });

    // A partição larga tudo, volta a disputar o lease e recupera do journal.
    await waitUntil(async () =>
      (await outputs(id)).some((o) => o.event_type === 'engine.trade_executed'),
    );
    // A recuperação pôs o livro ao vivo em HALTED, no journal, e avisou a sessão (RN-REC-003).
    await waitUntil(async () => (await journalCount(id)) === 4);
    // O aviso é gravado em outra transação, logo depois do journal.
    const notices = async () => {
      const { rows } = await sql<{ event_type: string }>`
        SELECT event_type FROM outbox_event WHERE partition_key = ${id} ORDER BY seq`.execute(db);
      return rows.map((r) => r.event_type);
    };
    await waitUntil(async () => (await notices()).length >= 2);
    expect(await notices()).toEqual(['engine.book_recovering', 'engine.book_recovered']);
    await waitUntil(() => app.partitions().some((p) => p.engine(id)?.phase === 'HALTED'));
  });

  it('o sequenciador retoma do offset salvo e não repete o que já estava no journal', async () => {
    const id = uuidv7();
    const a = await engine();
    await phase(id, 'CLOSED');
    await waitUntil(async () => (await journalCount(id)) === 1);
    await a.stop();
    // Enquanto ninguém lê, o comando fica no stream.
    await phase(id, 'CONTINUOUS');
    const b = await engine();
    await waitUntil(async () => (await journalCount(id)) === 2);
    await b
      .partitions()
      .find((p) => p.engine(id))
      ?.idle();
    expect(await journalCount(id)).toBe(2);
    await b.stop();
  });

  it('snapshot + replay regeneram as mesmas saídas em menos de 30 s (ME-012, RNF-022)', async () => {
    const id = uuidv7();
    // 20 mil entradas no journal, direto no banco, com o snapshot no meio do caminho.
    const reference = new InstrumentEngine(id);
    const inputs: EngineInput[] = [];
    const ts = clock.now().epochMillis;
    let seq = 0;
    const push = (command: EngineInput['command']) => {
      const input = { inputSeq: ++seq, ts, tradingDate: '2026-03-03', seed: 1, command };
      inputs.push(input);
      reference.process(input);
    };
    push({ kind: 'PhaseChange', phase: 'CLOSED' });
    push({ kind: 'PhaseChange', phase: 'CONTINUOUS' });
    for (let i = 0; i < 20_000; i++)
      push({
        kind: 'NewOrder',
        orderId: `0192a3c0-0000-7000-8000-${String(i).padStart(12, '0')}`,
        accountId: `0192a3c0-0000-7000-8000-a${String(i % 50).padStart(11, '0')}`,
        participantType: 'CUSTOMER',
        board: 'MAIN',
        side: i % 2 ? 'BUY' : 'SELL',
        type: 'LIMIT',
        quantity: 100,
        limitPrice: i % 2 ? (9.5 + (i % 40) / 100).toFixed(2) : (10 + (i % 40) / 100).toFixed(2),
        timeInForce: 'DAY',
        stpPolicy: 'CANCEL_AGGRESSOR',
      });

    const rows = inputs.map((input) => ({
      id,
      seq: input.inputSeq,
      command: input.command,
      ts: new Date(input.ts).toISOString(),
    }));
    await sql`
      INSERT INTO engine_journal (instrument_id, input_seq, command, ts, trading_date, seed, correlation_id)
      SELECT id, seq, command, ts, '2026-03-03', 1, 'seed'
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        AS x(id text, seq bigint, command jsonb, ts timestamptz)`.execute(db);
    // A mesma partição para onde o barramento roteia os comandos deste instrumento.
    const partitionOf = partitionIndex(id, 2);
    await sql`INSERT INTO engine_instrument (instrument_id, partition) VALUES (${id}, ${partitionOf})`.execute(
      db,
    );
    const half = new InstrumentEngine(id);
    for (const input of inputs.slice(0, 10_000)) half.process(input);
    await sql`
      INSERT INTO engine_snapshot (instrument_id, input_seq, state, taken_at)
      VALUES (${id}, ${half.inputSeq}, ${JSON.stringify(half.snapshot())}::jsonb, now())`.execute(
      db,
    );

    const started = performance.now();
    const app = await engine();
    await waitUntil(() => app.partition(partitionOf)?.engine(id) !== undefined, 60_000);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(30_000);

    const live = app.partition(partitionOf)!.engine(id)!;
    // Passou pelo mesmo estado do original, mais a suspensão da recuperação.
    expect(live.bookView('MAIN')).toEqual(reference.bookView('MAIN'));
    expect(live.phase).toBe('HALTED');

    // Sem snapshot, do zero: o replay administrativo compara com o que ficou gravado.
    const headers = await bearer(['BO_MARKET']);
    // Só a metade final foi regravada (o snapshot cobre o resto): completa a primeira metade.
    const replay = new InstrumentEngine(id);
    const head = inputs.slice(0, 10_000).flatMap((i) => replay.process(i));
    const { outputRow } = await import('../src/application/partition.js');
    await app.store.writeOutputs(head.map((o) => outputRow(id, o, null, 'seed')));
    const res = await request(app.service.app)
      .post(`/v1/admin/engine/books/${id}/replay`)
      .set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ identical: true, firstDifference: null });
    expect(res.body.inputs).toBe(20_003);
    await app.stop();
  }, 120_000);

  it('API administrativa: snapshot, status e nenhuma rota de negócio (Catálogo §9)', async () => {
    const app = await engine();
    const id = uuidv7();
    await phase(id, 'CONTINUOUS');
    await waitUntil(async () => (await journalCount(id)) === 1);
    const http = request(app.service.app);
    const headers = await bearer(['BO_ADMIN']);
    await waitUntil(() => app.partitions().some((p) => p.engine(id)));

    const list = await http.get('/v1/admin/engine/books').set(headers);
    expect(list.status).toBe(200);
    expect(list.body.items).toContainEqual(
      expect.objectContaining({ instrumentId: id, phase: 'CONTINUOUS', inputSeq: 1 }),
    );

    const snap = await http.post(`/v1/admin/engine/books/${id}/snapshot`).set(headers);
    expect(snap.status).toBe(200);
    expect(snap.body).toEqual({ instrumentId: id, inputSeq: 1 });
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM engine_snapshot WHERE instrument_id = ${id}`.execute(db);
    expect(Number(rows[0]!.n)).toBe(1);

    const unknown = await http.post(`/v1/admin/engine/books/${uuidv7()}/snapshot`).set(headers);
    expect(unknown.status).toBe(404);
    const forbidden = await http
      .post(`/v1/admin/engine/books/${id}/snapshot`)
      .set(await bearer(['BO_SUPPORT']));
    expect(forbidden.status).toBe(403);
    expect((await http.post('/v1/orders').set(headers).send({})).status).toBe(404);
    await app.stop();
  });

  it('a rotina das notas corta o trade bust pelo próprio tópico de comandos (RN-BST-001)', async () => {
    const app = await engine();
    const id = uuidv7();
    await phase(id, 'CONTINUOUS');
    await waitUntil(async () => (await journalCount(id)) === 1);

    const scheduler = await PartitionedProducer.create(
      client,
      topicName(ENV, 'scheduler'),
      `test-${uuidv7()}`,
    );
    const eventId = uuidv7();
    const envelope: Envelope = {
      eventId,
      eventType: RoutineTriggeredV1.eventType,
      eventVersion: 1,
      source: 'scheduler-service',
      environment: ENV,
      occurredAt: clock.now().toString(),
      partitionKey: 'brokerage_notes',
      correlationId: eventId,
      actor: { type: 'SYSTEM', id: 'scheduler-service' },
      auditable: false,
      payload: {
        routineName: 'brokerage_notes',
        businessDate: '2026-03-03',
        executionId: uuidv7(),
        attempt: 1,
        scheduledFor: clock.now().toString(),
        catchUp: false,
      },
    };
    await scheduler.sendAll([
      {
        partitionKey: 'brokerage_notes',
        publishingId: 1n,
        messageId: eventId,
        body: Buffer.from(JSON.stringify(envelope)),
      },
    ]);
    await waitUntil(async () => (await journalCount(id)) === 2, 30_000);
    const { rows } = await sql<{ command: { kind: string; tradingDate: string } }>`
      SELECT command FROM engine_journal WHERE instrument_id = ${id} AND input_seq = 2`.execute(db);
    expect(rows[0]!.command).toEqual({ kind: 'NotesCutoff', tradingDate: '2026-03-03' });
    await app.stop();
  });

  it('o lease garante um escritor por partição, e o outro assume quando o primeiro sai', async () => {
    const a = await engine();
    await waitUntil(() => a.partitions().length === 2);
    const b = await engine();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(b.partitions()).toHaveLength(0);

    await a.stop();
    await waitUntil(() => b.partitions().length === 2);
    const id = uuidv7();
    await phase(id, 'CONTINUOUS');
    await waitUntil(async () => (await journalCount(id)) === 1);
    await b.stop();
  });

  it('o journal é append-only para o usuário da aplicação', async () => {
    await expect(sql`DELETE FROM engine_journal`.execute(db)).rejects.toThrow();
    await expect(sql`UPDATE engine_journal SET seed = 0`.execute(db)).rejects.toThrow();
  });
});
