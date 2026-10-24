import { createLogger, createService } from '@broker/service-kit';
import { seededRandom, testClock } from '@broker/testing';
import { Writable } from 'node:stream';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  behaviorFromConfig,
  html,
  NO_FAULTS,
  registerControlRoutes,
  SimulatorControl,
} from '../src/index.js';

function simulator(behavior = NO_FAULTS, seed = 1) {
  const clock = testClock('2026-03-02T13:00:00Z');
  const silent = new Writable({ write: (_c, _e, cb) => cb() });
  const logger = createLogger({
    service: 'sim',
    environment: 'test',
    version: '0',
    level: 'fatal',
    clock,
    destination: silent,
  });
  const service = createService({
    config: {
      SERVICE_NAME: 'sim',
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
  const random = seededRandom(seed);
  const control = new SimulatorControl<'NEXT_FAILS'>(behavior, clock, () => random.next());
  registerControlRoutes(service, control, [{ id: 'NEXT_FAILS', label: 'Próxima falha' }]);
  service.use(control.middleware());
  service.route({
    method: 'get',
    path: '/api/ping',
    auth: 'public',
    handler: async () => ({ body: { ok: true } }),
  });
  return { service, control, clock };
}

describe('comportamento configurável (RN-SIM-002)', () => {
  it('lê o comportamento das variáveis de ambiente', () => {
    expect(
      behaviorFromConfig({
        SIM_LATENCY_MS: '2000-10000',
        SIM_TRANSIENT_ERROR_RATE: 0.1,
        SIM_TRANSIENT_MODE: 'mixed',
        SIM_HANG_MS: 1000,
        SIM_DEFINITIVE_ERROR_RATE: 0.01,
        SIM_UNAVAILABLE: '2026-03-02T13:00:00Z/2026-03-02T13:10:00Z',
      }),
    ).toMatchObject({
      latency: { kind: 'uniform', minMs: 2000, maxMs: 10000 },
      transientMode: 'mixed',
      unavailability: [{ from: expect.anything(), to: expect.anything() }],
    });
  });

  it('RN-SIM-002: com taxa de erro transitório de 50%, cerca de metade responde 5xx', async () => {
    const { service } = simulator({ ...NO_FAULTS, transientErrorRate: 0.5 });
    const statuses = [];
    for (let i = 0; i < 200; i++)
      statuses.push((await request(service.app).get('/api/ping')).status);
    const errors = statuses.filter((s) => s === 503).length;
    expect(errors).toBeGreaterThan(70);
    expect(errors).toBeLessThan(130);
    expect(statuses.filter((s) => s !== 503 && s !== 200)).toEqual([]);
  });

  it('RN-SIM-002: erro definitivo responde 422 com Problem Details', async () => {
    const { service } = simulator({ ...NO_FAULTS, definitiveErrorRate: 1 });
    const res = await request(service.app).get('/api/ping');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SIMULATED_DEFINITIVE_ERROR');
  });

  it('RN-SIM-002: modo timeout derruba a conexão sem resposta', async () => {
    const { service } = simulator({
      ...NO_FAULTS,
      transientErrorRate: 1,
      transientMode: 'timeout',
      hangMs: 10,
    });
    await expect(request(service.app).get('/api/ping')).rejects.toThrow(
      /socket hang up|ECONNRESET/,
    );
  });

  it('RN-SIM-002: janela de indisponibilidade de 10 min responde 503 com Retry-After e acaba sozinha', async () => {
    const { service, control, clock } = simulator();
    const created = await request(service.app).post('/admin/unavailability').send({ minutes: 10 });
    expect(created.body).toEqual({
      from: '2026-03-02T13:00:00.000Z',
      to: '2026-03-02T13:10:00.000Z',
    });
    const down = await request(service.app).get('/api/ping');
    expect(down.status).toBe(503);
    expect(down.headers['retry-after']).toBe('600');
    // O controle continua respondendo durante a queda.
    expect((await request(service.app).get('/admin/behavior')).body.unavailableUntil).toBe(
      '2026-03-02T13:10:00.000Z',
    );
    clock.advanceBy(10 * 60_000);
    expect((await request(service.app).get('/api/ping')).status).toBe(200);
    expect(control.unavailableUntil()).toBeUndefined();
  });

  it('a latência e as taxas mudam em tempo de execução pela API admin', async () => {
    const { service, control } = simulator();
    const res = await request(service.app)
      .put('/admin/behavior')
      .send({ latencyMs: '5-10', definitiveErrorRate: 0.2 });
    expect(res.body).toMatchObject({ latencyMs: '5-10', definitiveErrorRate: 0.2 });
    expect(control.behavior.latency).toEqual({ kind: 'uniform', minMs: 5, maxMs: 10 });
  });
});

describe('cenários forçáveis e UI (RN-SIM-005)', () => {
  it('um cenário armado vale para a próxima operação e depois desarma', async () => {
    const { service, control } = simulator();
    await request(service.app).post('/admin/scenarios').send({ scenario: 'NEXT_FAILS', times: 2 });
    expect(control.consume('NEXT_FAILS')).toBe(true);
    expect(control.consume('NEXT_FAILS')).toBe(true);
    expect(control.consume('NEXT_FAILS')).toBe(false);
    expect(
      (await request(service.app).post('/admin/scenarios').send({ scenario: 'X' })).status,
    ).toBe(422);
  });

  it('os formulários da UI armam cenário e redirecionam para /ui', async () => {
    const { service, control } = simulator();
    const res = await request(service.app)
      .post('/ui/control/scenarios')
      .type('form')
      .send({ scenario: 'NEXT_FAILS' });
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe('/ui');
    expect(control.armedScenarios()).toEqual([{ scenario: 'NEXT_FAILS', remaining: 1 }]);
  });

  it('html`` escapa o que vem de fora', () => {
    const name = '<script>alert("x")</script>';
    expect(html`<td>${name}</td>`.value).toBe(
      '<td>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</td>',
    );
  });
});
