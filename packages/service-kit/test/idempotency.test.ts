import { Valkey } from 'iovalkey';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import Type from 'typebox';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  etag,
  IdempotencyStore,
  requireIfMatch,
  serviceUnavailable,
  updateVersioned,
} from '../src/index.js';
import { serviceDb, sleep, testService } from './helpers.js';

let db: Kysely<unknown>;
let valkey: Valkey;
let deposits: number;
let failNext = false;

const Deposit = Type.Object({ amount: Type.String({ pattern: '^\\d+\\.\\d{2}$' }) });

function app(withValkey = true) {
  const { service } = testService({
    idempotency: new IdempotencyStore({ db, ...(withValkey ? { valkey } : {}) }),
  });
  service.route({
    method: 'post',
    path: '/v1/me/deposits',
    auth: 'public',
    validate: { body: Deposit },
    handler: async (req) => {
      if (failNext) {
        failNext = false;
        throw serviceUnavailable();
      }
      await sleep(50);
      deposits++;
      return {
        status: 201,
        body: {
          depositId: `dep-${deposits}`,
          amount: { amount: req.body.amount, currency: 'BRL' },
        },
      };
    },
  });
  service.route({
    method: 'put',
    path: '/v1/me/watchlists/:id',
    auth: 'public',
    validate: {
      params: Type.Object({ id: Type.String() }),
      body: Type.Object({ name: Type.String() }),
    },
    handler: async (req) => {
      const expected = requireIfMatch(req.headers['if-match'] as string | undefined);
      const version = await updateVersioned(db, {
        table: 'watchlist',
        id: req.params.id,
        expectedVersion: expected,
        set: { name: req.body.name },
      });
      return { body: { id: req.params.id, name: req.body.name }, headers: { ETag: etag(version) } };
    },
  });
  return service;
}

beforeAll(async () => {
  db = await serviceDb('kit', {
    '0001_watchlist': {
      async up(m: Kysely<unknown>) {
        await sql`CREATE TABLE watchlist (id text PRIMARY KEY, name text NOT NULL, version integer NOT NULL DEFAULT 1)`.execute(
          m,
        );
      },
    },
  });
  const { valkey: v } = inject('kit');
  valkey = new Valkey({ host: v.host, port: v.port });
  deposits = 0;
});

afterAll(async () => {
  valkey?.disconnect();
  await db?.destroy();
});

describe('idempotência de comandos (RN-PAD §4)', () => {
  it('spec: repetir com a mesma chave e o mesmo corpo devolve a resposta original e não cria outro depósito', async () => {
    const service = app();
    const first = await request(service.app)
      .post('/v1/me/deposits')
      .set('Idempotency-Key', 'key-repeat-0001')
      .send({ amount: '100.00' })
      .expect(201);
    const before = deposits;
    // Mesmo corpo com os campos em outra ordem também conta como a mesma requisição.
    const again = await request(service.app)
      .post('/v1/me/deposits')
      .set('Idempotency-Key', 'key-repeat-0001')
      .send({ amount: '100.00' })
      .expect(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(deposits).toBe(before);
  });

  it('spec: a mesma chave com outro valor → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const service = app();
    await request(service.app)
      .post('/v1/me/deposits')
      .set('Idempotency-Key', 'key-reuse-00001')
      .send({ amount: '100.00' })
      .expect(201);
    const reused = await request(service.app)
      .post('/v1/me/deposits')
      .set('Idempotency-Key', 'key-reuse-00001')
      .send({ amount: '999.00' })
      .expect(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('o banco é a fonte: sem o Valkey (ou com ele vazio) a repetição continua funcionando', async () => {
    const first = await request(app().app)
      .post('/v1/me/deposits')
      .set('Idempotency-Key', 'key-db-path-001')
      .send({ amount: '5.00' })
      .expect(201);
    await valkey.flushall();
    const before = deposits;
    const again = await request(app(false).app)
      .post('/v1/me/deposits')
      .set('Idempotency-Key', 'key-db-path-001')
      .send({ amount: '5.00' })
      .expect(201);
    expect(again.body).toEqual(first.body);
    expect(deposits).toBe(before);
    const row = await sql<{
      response_status: number;
    }>`SELECT response_status FROM idempotency_record WHERE key = 'key-db-path-001'`.execute(db);
    expect(row.rows[0]!.response_status).toBe(201);
  });

  it('duas requisições simultâneas com a mesma chave: só uma executa', async () => {
    const service = app();
    const before = deposits;
    const [a, b] = await Promise.all([
      request(service.app)
        .post('/v1/me/deposits')
        .set('Idempotency-Key', 'key-concurrent1')
        .send({ amount: '1.00' }),
      request(service.app)
        .post('/v1/me/deposits')
        .set('Idempotency-Key', 'key-concurrent1')
        .send({ amount: '1.00' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a.body.code, b.body.code]).toContain('IDEMPOTENCY_REQUEST_IN_PROGRESS');
    expect(deposits).toBe(before + 1);
  });

  it('falha técnica (5xx) libera a chave: o cliente pode repetir e o comando roda', async () => {
    const service = app();
    failNext = true;
    await request(service.app)
      .post('/v1/me/deposits')
      .set('Idempotency-Key', 'key-retry-5xx-1')
      .send({ amount: '2.00' })
      .expect(503);
    await request(service.app)
      .post('/v1/me/deposits')
      .set('Idempotency-Key', 'key-retry-5xx-1')
      .send({ amount: '2.00' })
      .expect(201);
  });

  it('POST sem Idempotency-Key → 400', async () => {
    const res = await request(app().app)
      .post('/v1/me/deposits')
      .send({ amount: '1.00' })
      .expect(400);
    expect(res.body.errors[0]).toMatchObject({ field: 'Idempotency-Key', code: 'REQUIRED' });
  });

  it('a chave vale por 24 h: expirada, a mesma chave executa de novo', async () => {
    const service = app(false);
    await request(service.app)
      .post('/v1/me/deposits')
      .set('Idempotency-Key', 'key-expired-001')
      .send({ amount: '3.00' })
      .expect(201);
    await sql`UPDATE idempotency_record SET expires_at = now() - interval '1 second' WHERE key = 'key-expired-001'`.execute(
      db,
    );
    const before = deposits;
    await request(service.app)
      .post('/v1/me/deposits')
      .set('Idempotency-Key', 'key-expired-001')
      .send({ amount: '3.00' })
      .expect(201);
    expect(deposits).toBe(before + 1);
  });
});

describe('concorrência otimista (RN-BE-041)', () => {
  it('spec: duas alterações com o mesmo If-Match → a primeira aplica, a segunda recebe 409', async () => {
    await sql`INSERT INTO watchlist (id, name) VALUES ('wl-1', 'Bancos')`.execute(db);
    const service = app();
    const first = await request(service.app)
      .put('/v1/me/watchlists/wl-1')
      .set('If-Match', '"1"')
      .send({ name: 'Bancos BR' })
      .expect(200);
    expect(first.headers['etag']).toBe('"2"');
    const second = await request(service.app)
      .put('/v1/me/watchlists/wl-1')
      .set('If-Match', '"1"')
      .send({ name: 'Outra' })
      .expect(409);
    expect(second.body.code).toBe('VERSION_CONFLICT');
    const row = await sql<{ name: string }>`SELECT name FROM watchlist WHERE id = 'wl-1'`.execute(
      db,
    );
    expect(row.rows[0]!.name).toBe('Bancos BR');
  });

  it('sem If-Match → 428 IF_MATCH_REQUIRED', async () => {
    const res = await request(app().app)
      .put('/v1/me/watchlists/wl-1')
      .send({ name: 'x' })
      .expect(428);
    expect(res.body.code).toBe('IF_MATCH_REQUIRED');
  });
});
