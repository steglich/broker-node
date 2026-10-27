import { Instant } from '@broker/domain-kernel';
import type { Valkey } from 'iovalkey';
import type { ProviderCache } from '../application/ports.js';

/** Cache da brapi no Valkey (D16): `md:<chave>` com validade; o banco continua sendo a fonte. */
export class ValkeyProviderCache implements ProviderCache {
  constructor(
    private readonly valkey: Valkey,
    private readonly prefix = 'md:',
  ) {}

  async get<T>(key: string): Promise<{ value: T; storedAt: Instant } | null> {
    const raw = await this.valkey.get(this.prefix + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value: T; storedAt: string };
    return { value: parsed.value, storedAt: Instant.parse(parsed.storedAt) };
  }

  async set(key: string, value: unknown, storedAt: Instant, ttlMs: number): Promise<void> {
    await this.valkey.set(
      this.prefix + key,
      JSON.stringify({ value, storedAt: storedAt.toString() }),
      'PX',
      Math.max(1, Math.round(ttlMs)),
    );
  }
}

/** Cache em memória (testes e execução sem Valkey). A validade segue o relógio do ambiente. */
export class MemoryProviderCache implements ProviderCache {
  private readonly entries = new Map<
    string,
    { value: unknown; storedAt: Instant; expiresAt: number }
  >();

  constructor(private readonly now: () => Instant) {}

  async get<T>(key: string): Promise<{ value: T; storedAt: Instant } | null> {
    const e = this.entries.get(key);
    if (!e || e.expiresAt <= this.now().epochMillis) return null;
    return { value: e.value as T, storedAt: e.storedAt };
  }

  async set(key: string, value: unknown, storedAt: Instant, ttlMs: number): Promise<void> {
    this.entries.set(key, { value, storedAt, expiresAt: storedAt.epochMillis + ttlMs });
  }
}
