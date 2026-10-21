import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiClient, assertProblem, eventually, waitUntil } from '../src/index.js';

describe('utilitários de E2E', () => {
  let server: Server;
  let baseUrl: string;
  const seen: Record<string, string | undefined>[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ ...req.headers } as Record<string, string | undefined>);
      if (req.url === '/missing') {
        res.writeHead(404, { 'content-type': 'application/problem+json' });
        res.end(
          JSON.stringify({
            status: 404,
            code: 'NOT_FOUND',
            correlationId: req.headers['x-correlation-id'],
          }),
        );
        return;
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, body: body ? JSON.parse(body) : null }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('RN-BE-011: cada chamada leva correlação; token e Idempotency-Key opcionais', async () => {
    const api = apiClient(baseUrl, { token: 'tok' });
    const res = await api.post('/x', { a: 1 }, { idempotencyKey: 'key-1' });
    expect(res.body).toEqual({ method: 'POST', body: { a: 1 } });
    const headers = seen.at(-1)!;
    expect(headers['x-correlation-id']).toBe(res.correlationId);
    expect(headers['authorization']).toBe('Bearer tok');
    expect(headers['idempotency-key']).toBe('key-1');
  });

  it('assertProblem confere status e código do Problem Details', async () => {
    const res = await apiClient(baseUrl).get('/missing');
    expect(assertProblem(res, 404, 'NOT_FOUND').correlationId).toBe(res.correlationId);
    expect(() => assertProblem(res, 409, 'CONFLICT')).toThrow(
      /esperado 409 CONFLICT, recebido 404/,
    );
  });

  it('waitUntil e eventually esperam o efeito ou estouram o prazo', async () => {
    let n = 0;
    await waitUntil(() => ++n >= 3, { intervalMs: 1 });
    expect(n).toBe(3);
    await expect(waitUntil(() => false, { timeoutMs: 20, what: 'o relay' })).rejects.toThrow(
      'tempo esgotado (20 ms) esperando o relay',
    );
    let tries = 0;
    expect(
      await eventually(
        () => {
          if (++tries < 3) throw new Error('ainda não');
          return tries;
        },
        { intervalMs: 1 },
      ),
    ).toBe(3);
  });
});
