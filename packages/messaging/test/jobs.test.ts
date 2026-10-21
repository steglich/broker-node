import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobQueue, openAmqp, startJobWorker, type AmqpSession, type Job } from '../src/index.js';
import { sleep, waitUntil } from './helpers.js';
import { amqpUrl } from './stream-fixture.js';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
let amqp: AmqpSession;
const stops: Array<() => Promise<void>> = [];

beforeAll(async () => {
  amqp = await openAmqp({ url: amqpUrl() });
});
afterAll(async () => {
  for (const stop of stops) await stop();
  await amqp?.connection.close().catch(() => undefined);
});

describe('filas de jobs (D6, RN-MSG-B §2)', () => {
  it('spec: o worker morre no meio do job sem ack e o job é reentregue a outro worker', async () => {
    const queue = new JobQueue(amqp, { name: 'prod.reporting.jobs.brokerage-note' });
    await queue.declare();
    await queue.enqueue('job-1', { accountId: 'acc-1', businessDate: '2026-10-16' });

    const output: string[] = [];
    const worker = spawn(
      process.execPath,
      ['--import', 'tsx', '--conditions=source', 'test/fixtures/job-worker.ts'],
      {
        cwd: pkgDir,
        env: {
          ...process.env,
          JOB_AMQP_URL: amqpUrl(),
          JOB_QUEUE: 'prod.reporting.jobs.brokerage-note',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    worker.stdout.on('data', (c: Buffer) =>
      output.push(...c.toString().split('\n').filter(Boolean)),
    );
    await waitUntil(() => output.includes('GOT job-1 1'), 15_000, 'worker A recebeu o job');

    // Worker B fica de prontidão; enquanto A segura o job (sem ack), B não o recebe.
    const received: Job[] = [];
    const b = await startJobWorker(amqp, queue, {
      prefetch: 1,
      handle: async (job) => {
        received.push(job);
      },
    });
    stops.push(b.stop);
    await sleep(500);
    expect(received).toEqual([]);

    worker.kill('SIGKILL'); // morte abrupta, sem ack
    await waitUntil(() => received.length === 1, 15_000, 'reentrega para o worker B');
    expect(received[0]).toMatchObject({
      jobId: 'job-1',
      deliveryCount: 2,
      payload: { accountId: 'acc-1' },
    });
    await waitUntil(
      async () =>
        (await amqp.channel.checkQueue('prod.reporting.jobs.brokerage-note')).messageCount === 0,
      5000,
      'fila vazia',
    );
  });

  it('prefetch limita quantos jobs um worker segura ao mesmo tempo', async () => {
    const queue = new JobQueue(amqp, { name: 'prod.reporting.jobs.export' });
    await queue.declare();
    for (const id of ['e1', 'e2', 'e3']) await queue.enqueue(id, {});
    const inFlight: string[] = [];
    const release: Array<() => void> = [];
    const w = await startJobWorker(amqp, queue, {
      prefetch: 2,
      handle: (job) =>
        new Promise<void>((resolve) => {
          inFlight.push(job.jobId);
          release.push(resolve);
        }),
    });
    stops.push(w.stop);
    await waitUntil(() => inFlight.length === 2, 10_000, 'dois em andamento');
    await sleep(400);
    expect(inFlight).toEqual(['e1', 'e2']); // o terceiro espera um ack
    release.shift()!();
    await waitUntil(() => inFlight.length === 3, 10_000, 'terceiro entregue');
    release.forEach((r) => r());
  });

  it('job que falha sempre vai para a DLQ da fila depois do limite de entregas', async () => {
    const queue = new JobQueue(amqp, { name: 'prod.reporting.jobs.poison', deliveryLimit: 3 });
    await queue.declare();
    await queue.enqueue('poison-1', {});
    const deliveries: number[] = [];
    const w = await startJobWorker(amqp, queue, {
      prefetch: 1,
      retryDelayMs: 100,
      handle: async (job) => {
        deliveries.push(job.deliveryCount);
        throw new Error('falha permanente no gerador (simulado)');
      },
    });
    stops.push(w.stop);
    await waitUntil(
      async () => (await amqp.channel.checkQueue(queue.dlqName)).messageCount === 1,
      15_000,
      'job na DLQ',
    );
    // Exatamente 3 entregas, sem laço de reentrega (no RabbitMQ 4 o nack não conta para o limite).
    expect(deliveries).toEqual([1, 2, 3]);
    expect((await amqp.channel.checkQueue(queue.name)).messageCount).toBe(0);
  });
});
