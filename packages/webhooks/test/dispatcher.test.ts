import { uuidv7 } from '@broker/ids';
import { createDatabase, migrateToLatest } from '@broker/persistence';
import { testClock } from '@broker/testing';
import { databaseConfig, startPostgres, type StartedPostgres } from '@broker/testing/containers';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyWebhook, WebhookDispatcher, webhookMigrations } from '../src/index.js';

const secret = 'segredo-do-simulador';

describe('despachante de webhooks (RN-SIM-004)', () => {
  let pg: StartedPostgres;
  let db: Kysely<unknown>;
  let server: Server;
  let url: string;
  /** Status que o receptor responde, em ordem; depois do fim da lista, 200. */
  let replies: number[] = [];
  let received: { headers: IncomingHttpHeaders; body: string }[] = [];

  beforeAll(async () => {
    pg = await startPostgres(['webhooks']);
    const migrator = createDatabase(databaseConfig(pg, 'webhooks', 'migrator'));
    await migrateToLatest(migrator, webhookMigrations);
    await migrator.destroy();
    db = createDatabase(databaseConfig(pg, 'webhooks', 'app'));
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(replies.shift() ?? 200).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks`;
  });
  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    await db?.destroy();
    await pg?.container.stop();
  });
  beforeEach(async () => {
    replies = [];
    received = [];
    await sql`DELETE FROM webhook_delivery`.execute(db);
  });

  it('RN-SIM-004: receptor responde 503 duas vezes; a 3ª tentativa entrega e o reenvio para', async () => {
    const clock = testClock('2026-03-02T13:00:00Z');
    const dispatcher = new WebhookDispatcher({ db, secret, clock, newId: uuidv7 });
    replies = [503, 503];
    const id = await dispatcher.enqueue(db, {
      eventId: 'evt-1',
      eventType: 'pix.recebido',
      url,
      body: { valor: '10.00' },
    });

    expect(await dispatcher.runDue()).toBe(1); // 1ª: 503
    expect(await dispatcher.runDue()).toBe(0); // backoff de 1 s ainda não venceu
    clock.advanceBy(1_000);
    expect(await dispatcher.runDue()).toBe(1); // 2ª: 503
    clock.advanceBy(4_999);
    expect(await dispatcher.runDue()).toBe(0); // 5 s depois da 2ª, ainda não
    clock.advanceBy(1);
    expect(await dispatcher.runDue()).toBe(1); // 3ª: 200
    clock.advanceBy(3_600_000);
    expect(await dispatcher.runDue()).toBe(0); // entregue: não reenvia

    expect(received).toHaveLength(3);
    const row = (await dispatcher.list()).find((r) => r.id === id)!;
    expect(row).toMatchObject({ status: 'DELIVERED', attempts: 3, last_status: 200 });
    // Mesmo X-Webhook-Id em todas as tentativas (idempotência do receptor); assinatura nova em cada uma.
    expect(new Set(received.map((r) => r.headers['x-webhook-id']))).toEqual(new Set(['evt-1']));
    expect(new Set(received.map((r) => r.headers['x-timestamp'])).size).toBe(3);
  });

  it('RN-SIM-003: cada tentativa chega assinada e válida para o relógio do receptor', async () => {
    const clock = testClock('2026-03-02T14:00:00Z');
    const dispatcher = new WebhookDispatcher({ db, secret, clock, newId: uuidv7 });
    replies = [500];
    await dispatcher.enqueue(db, {
      eventId: 'evt-2',
      eventType: 'pix.recebido',
      url,
      body: { a: 1 },
    });
    await dispatcher.runDue();
    // A 2ª tentativa acontece 1 h depois da 1ª: o timestamp é o da hora do envio, não o da criação.
    clock.advanceBy(3_600_000);
    await dispatcher.runDue();
    expect(received).toHaveLength(2);
    expect(verifyWebhook(received[1]!.headers, received[1]!.body, { secret, clock }).ok).toBe(true);
    expect(verifyWebhook(received[0]!.headers, received[0]!.body, { secret, clock })).toEqual({
      ok: false,
      reason: 'STALE_TIMESTAMP',
    });
  });

  it('RN-SIM-004: backoff 1 s → 5 s → 30 s → 2 min → 10 min → 1 h e depois de hora em hora', async () => {
    const clock = testClock('2026-03-02T15:00:00Z');
    const dispatcher = new WebhookDispatcher({ db, secret, clock, newId: uuidv7 });
    replies = Array(8).fill(503);
    const id = await dispatcher.enqueue(db, { eventId: 'evt-3', eventType: 'x', url, body: {} });
    const gaps: number[] = [];
    for (let i = 0; i < 8; i++) {
      await dispatcher.runDue();
      const row = (await dispatcher.list()).find((r) => r.id === id)!;
      const gap = row.next_attempt_at.getTime() - clock.now().epochMillis;
      gaps.push(gap);
      clock.advanceBy(gap);
    }
    expect(gaps).toEqual([1_000, 5_000, 30_000, 120_000, 600_000, 3_600_000, 3_600_000, 3_600_000]);
  });

  it('receptor fora do ar (conexão recusada) conta como falha e agenda o reenvio', async () => {
    const clock = testClock('2026-03-02T16:00:00Z');
    const dispatcher = new WebhookDispatcher({
      db,
      secret,
      clock,
      newId: uuidv7,
      timeoutMs: 2_000,
    });
    const id = await dispatcher.enqueue(db, {
      eventId: 'evt-4',
      eventType: 'x',
      url: 'http://127.0.0.1:1/nada',
      body: {},
    });
    await dispatcher.runDue();
    const row = (await dispatcher.list()).find((r) => r.id === id)!;
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBeTruthy();
  });

  it('notBefore segura a primeira tentativa (webhook atrasado)', async () => {
    const clock = testClock('2026-03-02T17:00:00Z');
    const dispatcher = new WebhookDispatcher({ db, secret, clock, newId: uuidv7 });
    await dispatcher.enqueue(db, {
      eventId: 'evt-5',
      eventType: 'x',
      url,
      body: {},
      notBefore: clock.now().plusMillis(60_000),
    });
    expect(await dispatcher.runDue()).toBe(0);
    clock.advanceBy(60_000);
    expect(await dispatcher.runDue()).toBe(1);
  });
});
