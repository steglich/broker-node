// Limite de taxa com janela deslizante no Valkey (D9, API §6): um sorted set por chave, com o
// instante de cada requisição aceita. A janela é exata e o script é atômico entre instâncias.
import type { Valkey } from 'iovalkey';

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Até liberar uma vaga (ms): o `RateLimit-Reset` e, se recusado, o `Retry-After`. */
  resetMs: number;
}

export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number, nowMs: number): Promise<RateDecision>;
  /** Falhas seguidas de credencial por IP (atraso progressivo). */
  failures(key: string): Promise<number>;
  recordFailure(key: string, ttlMs: number): Promise<void>;
  clearFailures(key: string): Promise<void>;
}

const SLIDING_WINDOW = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
local allowed = 0
if count < limit then
  redis.call('ZADD', key, now, ARGV[4])
  redis.call('PEXPIRE', key, window)
  count = count + 1
  allowed = 1
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local reset = 0
if oldest[2] then reset = tonumber(oldest[2]) + window - now end
return { allowed, limit - count, reset }
`;

let seq = 0;

export class ValkeyRateLimiter implements RateLimiter {
  constructor(
    private readonly valkey: Valkey,
    private readonly prefix = 'ratelimit',
  ) {}

  async hit(key: string, limit: number, windowMs: number, nowMs: number): Promise<RateDecision> {
    // O membro é único mesmo com duas requisições no mesmo milissegundo.
    const member = `${nowMs}-${process.pid}-${++seq}`;
    const [allowed, remaining, reset] = (await this.valkey.eval(
      SLIDING_WINDOW,
      1,
      `${this.prefix}:${key}`,
      nowMs,
      windowMs,
      limit,
      member,
    )) as [number, number, number];
    return {
      allowed: allowed === 1,
      limit,
      remaining: Math.max(0, remaining),
      resetMs: Math.max(0, reset),
    };
  }

  async failures(key: string): Promise<number> {
    return Number((await this.valkey.get(`${this.prefix}:fail:${key}`)) ?? 0);
  }

  async recordFailure(key: string, ttlMs: number): Promise<void> {
    const k = `${this.prefix}:fail:${key}`;
    await this.valkey.multi().incr(k).pexpire(k, ttlMs).exec();
  }

  async clearFailures(key: string): Promise<void> {
    await this.valkey.del(`${this.prefix}:fail:${key}`);
  }
}
