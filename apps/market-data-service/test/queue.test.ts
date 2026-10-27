import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/application/provider.js';
import {
  ProviderQueue,
  QueueTimeout,
  RequestDenied,
  type QueueOptions,
} from '../src/application/queue.js';
import { CircuitBreaker } from '../src/domain/circuit-breaker.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function queue(over: Partial<QueueOptions> = {}) {
  const sent: string[] = [];
  const q = new ProviderQueue({
    maxConcurrency: 1,
    minIntervalMs: 0,
    breaker: new CircuitBreaker({ failureThreshold: 5, openMs: 200 }),
    isLeader: () => true,
    gate: () => null,
    retry: { baseMs: 1, maxMs: 2, attempts: 1 },
    random: () => 0.5,
    ...over,
  });
  return { q, sent };
}

describe('fila única de saída (RN-BRP-040..043)', () => {
  it('RN-BRP-043: dez pedidos iguais ao mesmo tempo viram uma requisição, todos com o mesmo resultado', async () => {
    const { q } = queue();
    let calls = 0;
    const run = async () => {
      calls++;
      await sleep(20);
      return { lastPrice: '38.50' };
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        q.enqueue({ key: 'quote:WEGE3', kind: 'ON_DEMAND_QUOTE', priority: 3, run }),
      ),
    );
    expect(calls).toBe(1);
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toEqual({ lastPrice: '38.50' });
  });

  it('RN-BRP-040: no máximo 1 em andamento; RN-BRP-042: P0 antes de P5, FIFO na prioridade', async () => {
    const { q } = queue({ minIntervalMs: 5 });
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const job = (name: string) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(name);
      await sleep(5);
      inFlight--;
      return name;
    };
    // O primeiro sai na hora; os demais disputam pela prioridade.
    const all = [
      q.enqueue({ key: 'a', kind: 'CATALOG', priority: 5, run: job('catalog-1') }),
      q.enqueue({ key: 'b', kind: 'CATALOG', priority: 5, run: job('catalog-2') }),
      q.enqueue({ key: 'c', kind: 'HISTORY', priority: 4, run: job('history') }),
      q.enqueue({ key: 'd', kind: 'QUOTE', priority: 1, run: job('universe') }),
      q.enqueue({ key: 'e', kind: 'QUOTE', priority: 0, run: job('position') }),
    ];
    await Promise.all(all);
    expect(maxInFlight).toBe(1);
    expect(order).toEqual(['catalog-1', 'position', 'universe', 'history', 'catalog-2']);
  });

  it('RN-BRP-041: intervalo mínimo entre envios', async () => {
    const { q } = queue({ minIntervalMs: 40 });
    const starts: number[] = [];
    const run = async () => {
      starts.push(Date.now());
      return 1;
    };
    await Promise.all([
      q.enqueue({ key: 'x', kind: 'QUOTE', priority: 1, run }),
      q.enqueue({ key: 'y', kind: 'QUOTE', priority: 1, run }),
      q.enqueue({ key: 'z', kind: 'QUOTE', priority: 1, run }),
    ]);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(38);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(38);
  });

  it('só o líder envia (duas instâncias, RN-BRP-040)', async () => {
    let leader = false;
    const { q } = queue({ isLeader: () => leader });
    let calls = 0;
    const p = q.enqueue({ key: 'k', kind: 'QUOTE', priority: 1, run: async () => ++calls });
    await sleep(20);
    expect(calls).toBe(0);
    leader = true;
    q.pump();
    expect(await p).toBe(1);
  });

  it('RN-BRP-080: abre o disjuntor após 5 falhas 5xx seguidas; nada sai até a meia-abertura', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 5, openMs: 150 });
    const { q } = queue({ breaker });
    let calls = 0;
    const fail = async () => {
      calls++;
      throw new ProviderError('SERVER_ERROR', 'HTTP 503', { status: 503 });
    };
    for (let i = 0; i < 5; i++) {
      await expect(
        q.enqueue({ key: `f${i}`, kind: 'QUOTE', priority: 1, run: fail }),
      ).rejects.toThrow('503');
    }
    expect(calls).toBe(5);
    expect(q.breakerState()).toBe('OPEN');
    let ok = 0;
    const pending = q.enqueue({ key: 'probe', kind: 'QUOTE', priority: 1, run: async () => ++ok });
    await sleep(50);
    expect(ok).toBe(0);
    expect(await pending).toBe(1);
    expect(q.breakerState()).toBe('CLOSED');
  });

  it('Brapi §10: 5xx com retentativa por backoff até o limite', async () => {
    const { q } = queue({ retry: { baseMs: 5, maxMs: 20, attempts: 4 } });
    let calls = 0;
    const flaky = async () => {
      if (++calls < 3) throw new ProviderError('SERVER_ERROR', 'HTTP 500', { status: 500 });
      return 'ok';
    };
    expect(await q.enqueue({ key: 'r', kind: 'QUOTE', priority: 1, run: flaky })).toBe('ok');
    expect(calls).toBe(3);
  });

  it('429 por concorrência respeita o Retry-After e tenta de novo', async () => {
    const { q } = queue();
    let calls = 0;
    const started: number[] = [];
    const run = async () => {
      started.push(Date.now());
      if (++calls === 1)
        throw new ProviderError('RATE_LIMITED', '429', {
          status: 429,
          retryAfterMs: 40,
          quota: false,
        });
      return 'ok';
    };
    expect(await q.enqueue({ key: 'c', kind: 'QUOTE', priority: 1, run })).toBe('ok');
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(38);
  });

  it('o portão recusa sem enviar (orçamento, 401, capacidade)', async () => {
    const { q } = queue({ gate: (kind) => (kind === 'HISTORY' ? 'orçamento SAVING' : null) });
    let calls = 0;
    await expect(
      q.enqueue({ key: 'h', kind: 'HISTORY', priority: 4, run: async () => ++calls }),
    ).rejects.toBeInstanceOf(RequestDenied);
    expect(calls).toBe(0);
  });

  it('P3 com prazo: estoura em QueueTimeout e os outros que esperam ainda recebem', async () => {
    const { q } = queue();
    const slow = async () => {
      await sleep(60);
      return 'tarde';
    };
    const short = q.enqueue(
      { key: 's', kind: 'ON_DEMAND_QUOTE', priority: 3, run: slow },
      { waitTimeoutMs: 10 },
    );
    const patient = q.enqueue({ key: 's', kind: 'ON_DEMAND_QUOTE', priority: 3, run: slow });
    await expect(short).rejects.toBeInstanceOf(QueueTimeout);
    expect(await patient).toBe('tarde');
  });

  it('onSent conta cada envio, inclusive a falha com resposta (RN-BRP-032)', async () => {
    const seen: string[] = [];
    const { q } = queue({
      onSent: async (kind, o) => {
        seen.push(`${kind}:${o.ok ? 'ok' : o.error?.kind}`);
      },
    });
    await q.enqueue({ key: 'a', kind: 'QUOTE', priority: 1, run: async () => 1 });
    await q
      .enqueue({
        key: 'b',
        kind: 'QUOTE',
        priority: 1,
        run: async () => {
          throw new ProviderError('NOT_FOUND', '404', { status: 404 });
        },
      })
      .catch(() => undefined);
    await sleep(5);
    expect(seen).toEqual(['QUOTE:ok', 'QUOTE:NOT_FOUND']);
  });
});
