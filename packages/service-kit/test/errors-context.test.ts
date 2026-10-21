import { DomainError, Money } from '@broker/domain-kernel';
import { createDatabase } from '@broker/persistence';
import { sql } from 'kysely';
import request from 'supertest';
import Type from 'typebox';
import { describe, expect, it } from 'vitest';
import { businessRule, currentContext, type ExecutionContext } from '../src/index.js';
import { testService } from './helpers.js';

const OrderBody = Type.Object({
  symbol: Type.String({ pattern: '^[A-Z]{4}[0-9]{1,2}$' }),
  quantity: Type.Integer({ minimum: 1 }),
  price: Type.String({ pattern: '^\\d+\\.\\d{2}$' }),
});

function app() {
  const { service, lines } = testService();
  let seen: ExecutionContext | undefined;
  service.route({
    method: 'post',
    path: '/v1/orders',
    auth: 'public',
    idempotent: false,
    validate: { body: OrderBody },
    handler: async (req, ctx) => {
      seen = ctx;
      service.logger.info({ event: 'order.received', symbol: req.body.symbol }, 'ordem recebida');
      if (req.body.quantity > 1000) {
        throw businessRule('INSUFFICIENT_BUYING_POWER', 'Poder de compra insuficiente.', {
          required: Money.of('3851.15', 'BRL'),
          available: Money.of('2000.00', 'BRL'),
        });
      }
      return {
        status: 202,
        body: { orderId: 'o-1', correlationId: currentContext()?.correlationId },
      };
    },
  });
  service.route({
    method: 'get',
    path: '/v1/domain-error',
    auth: 'public',
    handler: async () => {
      Money.of('1.00', 'BRL').plus(Money.of('1.00', 'USD'));
      return {};
    },
  });
  service.route({
    method: 'get',
    path: '/v1/db',
    auth: 'public',
    handler: async () => {
      // Banco fora do ar: porta sem ninguém ouvindo.
      const db = createDatabase({
        host: '127.0.0.1',
        port: 1,
        database: 'x',
        user: 'x',
        password: 'x',
      });
      try {
        await sql`SELECT 1`.execute(db);
      } finally {
        await db.destroy();
      }
      return {};
    },
  });
  service.route({
    method: 'get',
    path: '/v1/bug',
    auth: 'public',
    handler: async () => {
      throw new TypeError(
        "Cannot read properties of undefined (reading 'accountId') at /app/src/secret-path.ts:42",
      );
    },
  });
  return { service, lines, seen: () => seen };
}

const valid = { symbol: 'PETR4', quantity: 100, price: '38.50' };

describe('contexto de execução (RN-BE-011)', () => {
  it('spec: X-Correlation-Id volta na resposta, aparece nos logs e chega ao caso de uso', async () => {
    const { service, lines, seen } = app();
    const res = await request(service.app)
      .post('/v1/orders')
      .set('X-Correlation-Id', 'abc')
      .set('X-Client-Channel', 'mobile')
      .set('User-Agent', 'broker-app/1.0')
      .send(valid)
      .expect(202);
    expect(res.headers['x-correlation-id']).toBe('abc');
    expect(res.body.correlationId).toBe('abc');
    expect(seen()).toMatchObject({
      correlationId: 'abc',
      channel: 'MOBILE',
      userAgent: 'broker-app/1.0',
      actor: { id: 'anonymous' },
    });
    expect(seen()!.requestedAt.toString()).toBe('2027-01-04T13:00:00.000Z'); // relógio do ambiente
    expect(lines.find((l) => l['event'] === 'order.received')).toMatchObject({
      correlation_id: 'abc',
    });
    expect(lines.find((l) => l['event'] === 'http.request')).toMatchObject({
      correlation_id: 'abc',
      status: 202,
      route: '/v1/orders',
    });
  });

  it('gera um correlationId quando não vem ou vem inválido', async () => {
    const { service } = app();
    const res = await request(service.app)
      .post('/v1/orders')
      .set('X-Correlation-Id', 'inválido com espaço')
      .send(valid)
      .expect(202);
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('Problem Details (RFC 9457, RN-BE-030..032)', () => {
  it('400: corpo fora do esquema lista os campos com code, em problem+json', async () => {
    const { service } = app();
    const res = await request(service.app)
      .post('/v1/orders')
      .set('X-Correlation-Id', 'corr-400')
      .send({ symbol: 'petr4', quantity: 0 })
      .expect(400)
      .expect('Content-Type', /application\/problem\+json/);
    expect(res.body).toMatchObject({
      type: 'https://docs.corretora-estudo.local/errors/validation-error',
      title: 'Requisição inválida',
      status: 400,
      code: 'VALIDATION_ERROR',
      instance: '/v1/orders',
      correlationId: 'corr-400',
    });
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'symbol', code: 'INVALID_FORMAT' }),
        expect.objectContaining({ field: 'quantity', code: 'MINIMUM' }),
        expect.objectContaining({ field: 'price', code: 'REQUIRED' }),
      ]),
    );
  });

  it('400: JSON malformado; 404: rota inexistente', async () => {
    const { service } = app();
    const bad = await request(service.app)
      .post('/v1/orders')
      .set('Content-Type', 'application/json')
      .send('{"symbol":')
      .expect(400);
    expect(bad.body.code).toBe('MALFORMED_JSON');
    const missing = await request(service.app).get('/v1/nada').expect(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND', correlationId: expect.any(String) });
  });

  it('422: regra de negócio com o code do domínio, contexto e dinheiro como string', async () => {
    const { service } = app();
    const res = await request(service.app)
      .post('/v1/orders')
      .set('X-Correlation-Id', 'corr-422')
      .send({ ...valid, quantity: 5000 })
      .expect(422);
    expect(res.body).toMatchObject({
      code: 'INSUFFICIENT_BUYING_POWER',
      title: 'Poder de compra insuficiente.',
      correlationId: 'corr-422',
      context: {
        required: { amount: '3851.15', currency: 'BRL' },
        available: { amount: '2000.00', currency: 'BRL' },
      },
    });
  });

  it('422: DomainError do domain-kernel vira o code do domínio', async () => {
    const { service } = app();
    const res = await request(service.app).get('/v1/domain-error').expect(422);
    expect(res.body.code).toBe('CURRENCY_MISMATCH');
    void DomainError;
  });

  it('spec: banco indisponível → 503 SERVICE_UNAVAILABLE, sem stack e com correlationId', async () => {
    const { service, lines } = app();
    const res = await request(service.app)
      .get('/v1/db')
      .set('X-Correlation-Id', 'corr-503')
      .expect(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 503,
      correlationId: 'corr-503',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|at /);
    // O detalhe técnico fica no log, com a mesma correlação.
    expect(lines.find((l) => l['event'] === 'http.unhandled_error')).toMatchObject({
      correlation_id: 'corr-503',
    });
  });

  it('RN-BE-031: erro inesperado → 500 INTERNAL_ERROR sem detalhes internos', async () => {
    const { service } = app();
    const res = await request(service.app).get('/v1/bug').expect(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/secret-path|accountId|TypeError/);
  });

  it('RN-API §3: respostas com dados de conta levam Cache-Control: no-store', async () => {
    const { service } = app();
    const res = await request(service.app).post('/v1/orders').send(valid).expect(202);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
