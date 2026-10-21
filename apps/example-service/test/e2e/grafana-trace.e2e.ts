/**
 * Verificação de ponta a ponta da tarefa 6.5 contra o ambiente local (`pnpm env:up infra`):
 * o example-service roda com a telemetria ligada; um POST gera um trace HTTP → outbox → relay →
 * RabbitMQ → consumidor que chega ao Tempo e é consultado pelo Grafana; as métricas RED chegam
 * ao Prometheus.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const appDir = fileURLToPath(new URL('../../', import.meta.url));
const secret = (name: string) => readFileSync(`${root}infra/secrets/${name}`, 'utf8').trim();
const grafanaAuth = `Basic ${Buffer.from(`admin:${secret('grafana_admin_password')}`).toString('base64')}`;
const node = (script: string, telemetry: boolean) => [
  '--import',
  'tsx',
  '--conditions=source',
  ...(telemetry ? ['--import', '@broker/service-kit/telemetry'] : []),
  script,
];

let proc: ChildProcess | undefined;
let port = 0;
const output: string[] = [];

const env = () => ({
  ...process.env,
  SERVICE_NAME: 'example-service',
  SERVICE_VERSION: '0.0.1',
  ENVIRONMENT: 'local',
  PORT: String(port),
  LOG_LEVEL: 'info',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
  OTEL_METRIC_EXPORT_INTERVAL: '1000',
  OTEL_BSP_SCHEDULE_DELAY: '200',
  DB_HOST: 'localhost',
  DB_NAME: 'example',
  DB_PASSWORD_FILE: `${root}infra/secrets/db/example_app`,
  DB_USER: 'example_app',
  STREAM_HOST: 'localhost',
  STREAM_USER: 'broker',
  STREAM_PASSWORD_FILE: `${root}infra/secrets/rabbitmq_password`,
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = createServer().listen(0, () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs)
      throw new Error(`tempo esgotado esperando ${what}; saída: ${output.slice(-5).join(' | ')}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const grafanaGet = async (path: string) => {
  const res = await fetch(`http://localhost:3000${path}`, {
    headers: { authorization: grafanaAuth },
  });
  if (!res.ok) throw new Error(`grafana ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
};

interface OtlpSpan {
  name: string;
  kind: string | number;
  spanId: string;
  parentSpanId?: string;
}

beforeAll(async () => {
  port = await freePort();
  // 1) Migração one-shot com o usuário migrador (como no compose).
  const migrate = spawnSync(process.execPath, node('src/migrate.ts', false), {
    cwd: appDir,
    env: {
      ...env(),
      DB_USER: 'example_migrator',
      DB_PASSWORD_FILE: `${root}infra/secrets/db/example_migrator`,
    },
    encoding: 'utf8',
  });
  expect(migrate.status, migrate.stdout + migrate.stderr).toBe(0);

  // 2) O serviço, com a telemetria carregada antes do código (`--import`).
  proc = spawn(process.execPath, node('src/main.ts', true), {
    cwd: appDir,
    env: env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (c: Buffer) => output.push(...c.toString().split('\n').filter(Boolean));
  proc.stdout!.on('data', collect);
  proc.stderr!.on('data', collect);
  await waitFor(
    async () => ((await fetch(`http://localhost:${port}/health/ready`)).ok ? true : undefined),
    60_000,
    'serviço pronto',
  );
}, 120_000);

afterAll(async () => {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((r) => proc!.once('exit', r));
  proc.kill('SIGTERM');
  await exited;
});

describe('trace de ponta a ponta no Grafana (RN-OBS §4)', () => {
  it('spec: HTTP → evento → consumidor no mesmo trace, consultado no Tempo pelo Grafana', async () => {
    const res = await fetch(`http://localhost:${port}/v1/pings`, {
      method: 'POST',
      headers: { 'x-correlation-id': 'e2e-trace' },
    });
    expect(res.status).toBe(202);
    const traceId = res.headers.get('x-trace-id');
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    const { pingId } = (await res.json()) as { pingId: string };

    // O consumidor processou o ping (relay → RabbitMQ → consumidor).
    await waitFor(
      async () => {
        const ping = (await (
          await fetch(`http://localhost:${port}/v1/pings/${pingId}`)
        ).json()) as { processedAt: string | null };
        return ping.processedAt ?? undefined;
      },
      20_000,
      'consumidor processar',
    );

    // O Grafana consulta o Tempo pelo datasource provisionado no otel-lgtm.
    const spans = await waitFor(
      async () => {
        const body = await grafanaGet(`/api/datasources/proxy/uid/tempo/api/traces/${traceId}`);
        const batches = (body['batches'] ?? body['resourceSpans'] ?? []) as Array<{
          scopeSpans?: Array<{ spans: OtlpSpan[] }>;
        }>;
        const all = batches.flatMap((b) => (b.scopeSpans ?? []).flatMap((s) => s.spans));
        return all.some((s) => s.name === 'process example.pinged') ? all : undefined;
      },
      30_000,
      'trace completo no Tempo',
    );
    const server = spans.find(
      (s) => /POST/.test(s.name) && (s.kind === 'SPAN_KIND_SERVER' || s.kind === 2),
    );
    const consumer = spans.find((s) => s.name === 'process example.pinged')!;
    expect(server, spans.map((s) => s.name).join(', ')).toBeDefined();
    // pg instrumentado automaticamente: o INSERT da outbox aparece no mesmo trace.
    expect(spans.some((s) => /INSERT|pg\.query/i.test(s.name))).toBe(true);
    // O span do consumidor descende da requisição HTTP.
    const byId = new Map(spans.map((s) => [s.spanId, s]));
    const chain: string[] = [];
    for (
      let s: OtlpSpan | undefined = consumer;
      s;
      s = s.parentSpanId ? byId.get(s.parentSpanId) : undefined
    )
      chain.push(s.name);
    expect(chain).toContain(server!.name);
    console.log(`trace ${traceId}: ${chain.join(' ← ')} (${spans.length} spans)`);
  }, 90_000);

  it('RN-OBS §2: métricas RED de HTTP e de consumidor chegam ao Prometheus', async () => {
    const has = async (q: string) => {
      const body = await grafanaGet(
        `/api/datasources/proxy/uid/prometheus/api/v1/query?query=${encodeURIComponent(q)}`,
      );
      return ((body['data'] as { result: unknown[] }).result ?? []).length > 0 ? true : undefined;
    };
    await waitFor(
      () => has('http_server_request_duration_seconds_count{job=~".*example-service"}'),
      60_000,
      'métrica HTTP',
    );
    await waitFor(
      () => has('messaging_consumer_messages_total{job=~".*example-service"}'),
      60_000,
      'métrica do consumidor',
    );
  }, 130_000);
});
