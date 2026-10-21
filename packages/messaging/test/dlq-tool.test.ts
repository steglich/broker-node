import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDlqHttpHandler,
  DlqAdmin,
  EventConsumer,
  EventPublisher,
  PermanentError,
  runDlqCli,
  topicName,
  type Envelope,
} from '../src/index.js';
import { clock, newId, waitUntil } from './helpers.js';
import { consumerDb, effects, envelope, streamSettings, TestProducer } from './stream-fixture.js';

const SUPER_STREAM = topicName('prod', 'tax');
let db: Kysely<unknown>;
let producer: TestProducer;
let consumer: EventConsumer;
let server: Server;
let url: string;
const broken = new Set<number>();

const cli = async (...args: string[]) => {
  const out: string[] = [];
  const code = await runDlqCli(['--url', url, ...args], (l) => out.push(l));
  return {
    code,
    body: JSON.parse(out.join('\n') || 'null') as Record<string, unknown> &
      Array<Record<string, unknown>>,
  };
};
const settled = (key: string, n: number) =>
  waitUntil(async () => (await effects(db, key)).length === n, 15_000, `${n} efeitos em ${key}`);
const deadLetterOf = async (eventId: string) =>
  (await sql<{ id: string }>`SELECT id FROM dead_letter WHERE event_id = ${eventId}`.execute(db))
    .rows[0]?.id;

beforeAll(async () => {
  db = await consumerDb('dlqtool');
  producer = await TestProducer.create(SUPER_STREAM);
  consumer = new EventConsumer({
    name: 'tax.calculator',
    environment: 'prod',
    superStream: SUPER_STREAM,
    stream: streamSettings(),
    db,
    ordered: true,
    newId,
    handlers: {
      'tax.trade_settled': {
        handle: async (trx, env: Envelope) => {
          const seq = (env.payload as { seq: number }).seq;
          if (broken.has(seq))
            throw new PermanentError(`não sei apurar o negócio ${seq} (simulado)`);
          await sql`INSERT INTO effect (event_id, partition_key, seq) VALUES (${env.eventId}, ${env.partitionKey}, ${seq})`.execute(
            trx,
          );
        },
      },
    },
  });
  await consumer.start();
  const admin = new DlqAdmin({
    db,
    consumers: [consumer],
    publisher: new EventPublisher({
      source: 'tax-service',
      environment: 'prod',
      clock: clock(),
      newId,
    }),
  });
  const handler = createDlqHttpHandler(admin);
  server = createServer(
    (req, res) => void handler(req, res).then((handled) => !handled && res.writeHead(404).end()),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await consumer?.stop();
  await producer?.close();
  await new Promise((r) => server?.close(r));
  await db?.destroy();
});

describe('ferramenta de DLQ (RN-MSG-B-036)', () => {
  it('RN-MSG-B-036: lista, inspeciona e o reprocessamento pela CLI desbloqueia a chave', async () => {
    broken.add(1);
    const first = envelope('tax.trade_settled', 'acc-X', { seq: 1 });
    await producer.send([
      first,
      envelope('tax.trade_settled', 'acc-X', { seq: 2 }),
      envelope('tax.trade_settled', 'acc-X', { seq: 3 }),
    ]);
    await waitUntil(async () => (await deadLetterOf(first.eventId)) !== undefined, 15_000, 'DLQ');
    const id = (await deadLetterOf(first.eventId))!;

    const list = await cli('list', '--status', 'PENDING', '--consumer', 'tax.calculator');
    expect(list.code).toBe(0);
    await waitUntil(
      async () => (await cli('inspect', id)).body['parkedBehind'] === 2,
      10_000,
      'duas estacionadas',
    );
    expect(list.body.map((d) => d['id'])).toContain(id);

    const detail = await cli('inspect', id);
    expect(detail.body).toMatchObject({
      status: 'PENDING',
      blocking: true,
      partitionKey: 'acc-X',
      eventId: first.eventId,
    });
    expect(String(detail.body['error'])).toMatch(/negócio 1/);

    // Reprocessar ainda com o bug falha, registra a tentativa e mantém a chave bloqueada.
    const failed = await cli('reprocess', id, '--operator', 'op-1', '--note', 'tentando');
    expect(failed.code).toBe(1);
    expect((await cli('inspect', id)).body).toMatchObject({
      status: 'PENDING',
      attempts: 2,
      blocking: true,
    });

    broken.delete(1);
    const ok = await cli('reprocess', id, '--operator', 'op-1', '--note', 'apuração corrigida');
    expect(ok.code).toBe(0);
    expect(ok.body).toMatchObject({
      status: 'REPROCESSED',
      resolvedBy: 'op-1',
      resolutionNote: 'apuração corrigida',
      blocking: false,
    });
    expect((await effects(db, 'acc-X')).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('RN-MSG-B-036: descarte exige justificativa, é auditado e libera a chave', async () => {
    broken.add(10);
    const bad = envelope('tax.trade_settled', 'acc-Y', { seq: 10 });
    await producer.send([bad, envelope('tax.trade_settled', 'acc-Y', { seq: 11 })]);
    await waitUntil(async () => (await deadLetterOf(bad.eventId)) !== undefined, 15_000, 'DLQ');
    const id = (await deadLetterOf(bad.eventId))!;
    await waitUntil(
      async () => (await cli('inspect', id)).body['parkedBehind'] === 1,
      10_000,
      'estacionada',
    );

    const noReason = await cli('discard', id, '--operator', 'op-2', '--justification', '   ');
    expect(noReason.code).toBe(1);
    expect(String(noReason.body['detail'])).toMatch(/justificativa/);

    const done = await cli(
      'discard',
      id,
      '--operator',
      'op-2',
      '--justification',
      'evento de teste enviado por engano',
    );
    expect(done.body).toMatchObject({ status: 'DISCARDED', resolvedBy: 'op-2', blocking: false });
    // A mensagem descartada não tem efeito; a que estava atrás dela é processada.
    await settled('acc-Y', 1);
    expect((await effects(db, 'acc-Y')).map((e) => e.seq)).toEqual([11]);
    // Auditoria: o descarte vira um evento auditável na outbox do serviço.
    const audit = await sql<{ payload: Record<string, string>; headers: Record<string, unknown> }>`
      SELECT payload, headers FROM outbox_event WHERE event_type = 'messaging.dead_letter_discarded'`.execute(
      db,
    );
    expect(audit.rows[0]!.payload).toMatchObject({
      deadLetterId: id,
      operator: 'op-2',
      justification: 'evento de teste enviado por engano',
    });
    expect(audit.rows[0]!.headers).toMatchObject({
      auditable: true,
      actor: { type: 'BACKOFFICE', id: 'op-2' },
    });

    // Mensagem já resolvida não pode ser reprocessada de novo.
    expect((await cli('reprocess', id, '--operator', 'op-2')).code).toBe(1);
  });

  it('CLI sem argumentos mostra o uso', async () => {
    const out: string[] = [];
    expect(await runDlqCli(['--url', url], (l) => out.push(l))).toBe(2);
    expect(out[0]).toMatch(/uso: broker-dlq/);
  });
});
