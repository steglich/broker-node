import { CircuitBreaker, type BreakerState } from '../domain/circuit-breaker.js';
import type { Priority, RequestKind } from '../domain/budget.js';
import { ProviderError } from './provider.js';

/** Pedido à fila: `key` identifica requisições idênticas (coalescência, RN-BRP-043). */
export interface QueueRequest<T> {
  key: string;
  kind: RequestKind;
  priority: Priority;
  /** Ticker pedido: os de teste dispensam token e passam pela trava do `401` (RN-BRP-034). */
  symbol?: string;
  run: () => Promise<T>;
}

/** O pedido não foi enviado: orçamento, trava de `401`, capacidade indisponível ou fila parada. */
export class RequestDenied extends Error {
  override readonly name = 'RequestDenied';
  constructor(readonly reason: string) {
    super(`requisição não enviada: ${reason}`);
  }
}

/** A espera do chamador acabou antes da resposta (P3: 5 s, depois o cache com aviso). */
export class QueueTimeout extends Error {
  override readonly name = 'QueueTimeout';
  constructor() {
    super('tempo de espera na fila esgotado');
  }
}

export interface QueueOptions {
  /** `brapi.plan.max_concurrency` (padrão 1, RN-BRP-040). */
  maxConcurrency: number;
  /** `brapi.min_interval` (padrão 1 s, RN-BRP-041), entre inícios de requisição. */
  minIntervalMs: number;
  breaker: CircuitBreaker;
  /** Só o líder envia (RN-BRP-040, D14). */
  isLeader: () => boolean;
  /** Orçamento, trava de `401` e capacidades: devolve o motivo da recusa, ou `null`. */
  gate: (kind: RequestKind, priority: Priority, symbol?: string) => string | null;
  /** Cada envio (RN-BRP-032: conta também o que falhou com resposta). */
  onSent?: (kind: RequestKind, outcome: { ok: boolean; error?: ProviderError }) => Promise<void>;
  /** Retentativa de `5xx`/timeout: backoff exponencial com jitter (base 2 s, máx. 5 min, 4×). */
  retry?: { baseMs: number; maxMs: number; attempts: number };
  /** Relógio de parede do processo (a brapi é real mesmo com o relógio do ambiente virtual). */
  wall?: () => number;
  random?: () => number;
  onError?: (err: unknown) => void;
}

interface Waiter {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer?: NodeJS.Timeout;
  done: boolean;
}

interface Entry {
  req: QueueRequest<unknown>;
  seq: number;
  attempts: number;
  /** Só sai depois (backoff da retentativa). */
  notBefore: number;
  waiters: Waiter[];
  inFlight: boolean;
}

/**
 * Fila única de saída para o provedor (RN-BRP-040..043, ADR-0007): no máximo `maxConcurrency`
 * em andamento, intervalo mínimo entre envios, prioridades P0–P5 (FIFO dentro da prioridade),
 * coalescência de pedidos idênticos (pendentes ou em andamento: todos recebem o mesmo resultado),
 * disjuntor (RN-BRP-080) e `Retry-After` do `429`. Só despacha no líder; nos demais, os pedidos
 * esperam (e os com prazo caem no cache).
 */
export class ProviderQueue {
  private readonly entries = new Map<string, Entry>();
  private seq = 0;
  private inFlight = 0;
  private lastStartAt = Number.NEGATIVE_INFINITY;
  private pausedUntil = 0;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly wall: () => number;
  private readonly random: () => number;
  private readonly retry: { baseMs: number; maxMs: number; attempts: number };
  /** Enviados por chave (para os testes de coalescência e o painel). */
  sentCount = 0;

  constructor(private readonly o: QueueOptions) {
    this.wall = o.wall ?? (() => Date.now());
    this.random = o.random ?? Math.random;
    this.retry = o.retry ?? { baseMs: 2000, maxMs: 300_000, attempts: 4 };
  }

  /** Enfileira (ou junta a um pedido idêntico) e espera o resultado. */
  enqueue<T>(req: QueueRequest<T>, opts: { waitTimeoutMs?: number } = {}): Promise<T> {
    if (this.stopped) return Promise.reject(new RequestDenied('fila parada'));
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = { resolve: resolve as (v: unknown) => void, reject, done: false };
      if (opts.waitTimeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          if (waiter.done) return;
          waiter.done = true;
          reject(new QueueTimeout());
        }, opts.waitTimeoutMs);
        waiter.timer.unref();
      }
      const existing = this.entries.get(req.key);
      if (existing) {
        existing.waiters.push(waiter);
        // Um pedido mais urgente sobe a prioridade do que já estava na fila.
        if (!existing.inFlight && req.priority < existing.req.priority)
          existing.req = { ...existing.req, priority: req.priority };
      } else {
        this.entries.set(req.key, {
          req: req as QueueRequest<unknown>,
          seq: this.seq++,
          attempts: 0,
          notBefore: 0,
          waiters: [waiter],
          inFlight: false,
        });
      }
      this.pump();
    });
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  depth(): Record<Priority, number> {
    const out: Record<Priority, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const e of this.entries.values()) if (!e.inFlight) out[e.req.priority]++;
    return out;
  }

  breakerState(): BreakerState {
    return this.o.breaker.state(this.wall());
  }

  /** Reavalia a fila (ex.: virou líder, orçamento mudou). */
  pump(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    // Recusados pelo portão (ex.: EXHAUSTED) saem já, sem esperar pausa nem intervalo.
    for (const e of [...this.entries.values()]) {
      if (e.inFlight) continue;
      const denied = this.o.gate(e.req.kind, e.req.priority, e.req.symbol);
      if (denied) this.settle(e, { error: new RequestDenied(denied) });
    }
    for (;;) {
      if (this.inFlight >= this.o.maxConcurrency || !this.o.isLeader()) return;
      const now = this.wall();
      const waitUntil = Math.max(this.lastStartAt + this.o.minIntervalMs, this.pausedUntil);
      if (now < waitUntil) return this.wake(waitUntil - now);
      const next = this.pick(now);
      if (!next) return;
      if ('wakeAt' in next) return this.wake(next.wakeAt - now);
      const entry = next.entry;
      const denied = this.o.gate(entry.req.kind, entry.req.priority, entry.req.symbol);
      if (denied) {
        this.settle(entry, { error: new RequestDenied(denied) });
        continue;
      }
      if (!this.o.breaker.tryAcquire(now)) {
        const reopen = this.o.breaker.reopensAt();
        return reopen === null ? undefined : this.wake(Math.max(1, reopen - now));
      }
      this.start(entry, now);
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const e of [...this.entries.values()])
      if (!e.inFlight) this.settle(e, { error: new RequestDenied('fila parada') });
  }

  private pick(now: number): { entry: Entry } | { wakeAt: number } | null {
    let best: Entry | undefined;
    let soonest = Number.POSITIVE_INFINITY;
    for (const e of this.entries.values()) {
      if (e.inFlight) continue;
      // Ninguém mais espera e o pedido nem começou: sai sem gastar cota.
      if (e.waiters.every((w) => w.done) && e.attempts === 0 && e.req.kind === 'ON_DEMAND_QUOTE') {
        this.entries.delete(e.req.key);
        continue;
      }
      if (e.notBefore > now) {
        soonest = Math.min(soonest, e.notBefore);
        continue;
      }
      if (
        !best ||
        e.req.priority < best.req.priority ||
        (e.req.priority === best.req.priority && e.seq < best.seq)
      )
        best = e;
    }
    if (best) return { entry: best };
    return Number.isFinite(soonest) ? { wakeAt: soonest } : null;
  }

  private start(entry: Entry, now: number): void {
    entry.inFlight = true;
    entry.attempts++;
    this.inFlight++;
    this.lastStartAt = now;
    this.sentCount++;
    void (async () => {
      try {
        const value = await entry.req.run();
        this.o.breaker.onSuccess();
        await this.sent(entry.req.kind, { ok: true });
        this.settle(entry, { value });
      } catch (err) {
        await this.onFailure(entry, err);
      } finally {
        this.inFlight--;
        this.pump();
      }
    })();
  }

  private async onFailure(entry: Entry, err: unknown): Promise<void> {
    const now = this.wall();
    const pe = err instanceof ProviderError ? err : undefined;
    if (pe?.transient) this.o.breaker.onFailure(now);
    else this.o.breaker.onNeutral();
    // O orçamento fica sabendo (ex.: 429 por cota) antes de quem esperava receber o erro.
    await this.sent(entry.req.kind, { ok: false, ...(pe ? { error: pe } : {}) });
    if (pe?.kind === 'RATE_LIMITED' && !pe.details.quota) {
      // 429 por concorrência: respeita o Retry-After e tenta de novo uma vez.
      this.pausedUntil = now + (pe.details.retryAfterMs ?? 1000);
      if (entry.attempts < 2) return this.requeue(entry, this.pausedUntil);
    } else if (pe?.kind === 'RATE_LIMITED') {
      this.pausedUntil = now + (pe.details.retryAfterMs ?? 60_000);
    }
    if (pe?.transient && entry.attempts < this.retry.attempts) {
      const exp = Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** (entry.attempts - 1));
      return this.requeue(entry, now + Math.round(exp * (0.5 + this.random())));
    }
    this.settle(entry, { error: err });
  }

  private requeue(entry: Entry, notBefore: number): void {
    entry.inFlight = false;
    entry.notBefore = notBefore;
  }

  private async sent(kind: RequestKind, outcome: { ok: boolean; error?: ProviderError }) {
    try {
      await this.o.onSent?.(kind, outcome);
    } catch (err) {
      this.o.onError?.(err);
    }
  }

  private settle(entry: Entry, r: { value?: unknown; error?: unknown }): void {
    this.entries.delete(entry.req.key);
    for (const w of entry.waiters) {
      if (w.done) continue;
      w.done = true;
      clearTimeout(w.timer);
      if ('error' in r && r.error !== undefined) w.reject(r.error);
      else w.resolve(r.value);
    }
  }

  private wake(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.pump(), Math.max(1, ms));
    this.timer.unref();
  }
}
