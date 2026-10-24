import { createLogger, createService } from '@broker/service-kit';
import { testClock } from '@broker/testing';
import { Writable } from 'node:stream';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { assertWebhookSignature, signedHeaders, signWebhook, verifyWebhook } from '../src/index.js';

const secret = 'segredo-de-teste';
const body = JSON.stringify({ endToEndId: 'ESIM1', valor: '10.00' });

describe('assinatura de webhook (RN-SIM-003)', () => {
  const clock = testClock('2026-03-02T13:00:00Z');
  const now = clock.now().epochMillis;

  it('RN-SIM-003: HMAC-SHA256 em hex sobre `timestamp.corpo`', () => {
    // Referência calculada à parte: printf '1772456400.<corpo>' | openssl dgst -sha256 -hmac segredo-de-teste
    const headers = signedHeaders(secret, now, body);
    expect(headers['X-Timestamp']).toBe('1772456400');
    expect(headers['X-Signature']).toBe(
      '4a0f42874cb9797755e1f4b0c8925d4b5fc424d867c090fc4e2da53410677500',
    );
  });

  it('RN-SIM-003: assinatura válida é aceita (headers em qualquer caixa)', () => {
    const h = signedHeaders(secret, now, body);
    expect(
      verifyWebhook({ 'x-timestamp': h['X-Timestamp'], 'x-signature': h['X-Signature'] }, body, {
        secret,
        clock,
      }),
    ).toEqual({
      ok: true,
      timestamp: 1772456400,
    });
  });

  it.each([
    ['corpo alterado', (h: Record<string, string>) => ({ h, b: body.replace('10.00', '99.00') })],
    [
      'segredo errado',
      (_h: Record<string, string>) => ({ h: signedHeaders('outro', now, body), b: body }),
    ],
    [
      'timestamp trocado sem reassinar',
      (h: Record<string, string>) => ({
        h: { ...h, 'X-Timestamp': String(Number(h['X-Timestamp']) + 1) },
        b: body,
      }),
    ],
    [
      'assinatura que não é hex',
      (h: Record<string, string>) => ({ h: { ...h, 'X-Signature': 'zz' }, b: body }),
    ],
  ])('RN-SIM-003: %s → INVALID_SIGNATURE', (_name, mutate) => {
    const { h, b } = mutate(signedHeaders(secret, now, body));
    const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
    expect(verifyWebhook(lower, b, { secret, clock })).toEqual({
      ok: false,
      reason: 'INVALID_SIGNATURE',
    });
  });

  it.each([
    ['6 min atrás', -6 * 60_000, false],
    ['6 min à frente', 6 * 60_000, false],
    ['4 min atrás', -4 * 60_000, true],
  ])('RN-SIM-003: timestamp de %s', (_name, offset, ok) => {
    const h = signedHeaders(secret, now + offset, body);
    const result = verifyWebhook(
      { 'x-timestamp': h['X-Timestamp'], 'x-signature': h['X-Signature'] },
      body,
      { secret, clock },
    );
    expect(result.ok).toBe(ok);
    if (!ok) expect(result).toEqual({ ok: false, reason: 'STALE_TIMESTAMP' });
  });

  it('sem headers → MISSING_HEADERS', () => {
    expect(verifyWebhook({}, body, { secret, clock })).toEqual({
      ok: false,
      reason: 'MISSING_HEADERS',
    });
  });
});

describe('receptor no service-kit', () => {
  const clock = testClock('2026-03-02T13:00:00Z');
  const silent = new Writable({ write: (_c, _e, cb) => cb() });
  const logger = createLogger({
    service: 'ledger',
    environment: 'test',
    version: '0',
    level: 'fatal',
    clock,
    destination: silent,
  });
  const service = createService({
    config: {
      SERVICE_NAME: 'ledger',
      SERVICE_VERSION: '0',
      GIT_COMMIT: 'x',
      ENVIRONMENT: 'test',
      PORT: 0,
      LOG_LEVEL: 'fatal',
      SHUTDOWN_TIMEOUT_MS: 0,
    },
    clock,
    logger,
  });
  let applied = 0;
  service.route({
    method: 'post',
    path: '/webhooks/pix',
    auth: 'public',
    idempotent: false,
    handler: async (req) => {
      assertWebhookSignature(req, { secret, clock });
      applied++;
      return { status: 204 };
    },
  });

  it('RN-SIM-003: assinatura inválida → 401 e nenhum efeito', async () => {
    const h = signedHeaders(secret, clock.now().epochMillis, body);
    const res = await request(service.app)
      .post('/webhooks/pix')
      .set('content-type', 'application/json')
      .set('x-timestamp', h['X-Timestamp']!)
      .set('x-signature', signWebhook('outro', Number(h['X-Timestamp']), body))
      .send(body);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    expect(applied).toBe(0);
  });

  it('RN-SIM-003: confere sobre os bytes recebidos (espaços e ordem de campos preservados)', async () => {
    const raw = '{ "valor":"10.00",   "endToEndId":"ESIM1" }';
    const h = signedHeaders(secret, clock.now().epochMillis, raw);
    const res = await request(service.app)
      .post('/webhooks/pix')
      .set('content-type', 'application/json')
      .set('x-timestamp', h['X-Timestamp']!)
      .set('x-signature', h['X-Signature']!)
      .send(raw);
    expect(res.status).toBe(204);
    expect(applied).toBe(1);
  });
});
