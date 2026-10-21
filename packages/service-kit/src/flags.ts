import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { HttpError } from './errors.js';

/** Tabela de sobrescrita por conta (RN-PAD-072). */
export const featureFlagMigrations: Record<string, Migration> = {
  '0000_platform_feature_flag': {
    async up(db: Kysely<unknown>) {
      await sql`
        CREATE TABLE feature_flag_override (
          flag        text NOT NULL,
          account_id  text NOT NULL,
          enabled     boolean NOT NULL,
          reason      text,
          updated_at  timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (flag, account_id)
        )`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`DROP TABLE IF EXISTS feature_flag_override`.execute(db);
    },
  },
};

/** Lê as flags do ambiente: `FEATURE_FLAGS='{"btc_enabled":false,"after_market_enabled":true}'`. */
export function parseFeatureFlags(json: string | undefined): Record<string, boolean> {
  if (!json) return {};
  const parsed = JSON.parse(json) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('FEATURE_FLAGS precisa ser um objeto JSON');
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'boolean') throw new Error(`FEATURE_FLAGS.${k} precisa ser true ou false`);
  }
  return parsed as Record<string, boolean>;
}

export const featureUnavailable = (flag: string) =>
  new HttpError(
    403,
    'FEATURE_UNAVAILABLE',
    `A funcionalidade ${flag} não está disponível neste ambiente.`,
    { context: { flag } },
  );

/**
 * Feature flags (RN-PAD-072, D18): o valor do ambiente vale para todos; a tabela
 * `feature_flag_override` do serviço sobrescreve por conta. Flag desconhecida = desligada.
 */
export class FeatureFlags {
  private readonly cache = new Map<string, { value: boolean | null; at: number }>();

  constructor(
    private readonly options: {
      defaults: Record<string, boolean>;
      db?: Kysely<unknown>;
      cacheTtlMs?: number;
    },
  ) {}

  async isEnabled(flag: string, accountId?: string): Promise<boolean> {
    if (accountId && this.options.db) {
      const override = await this.override(flag, accountId);
      if (override !== null) return override;
    }
    return this.options.defaults[flag] ?? false;
  }

  /** Para caso de uso e consumidor: lança `FEATURE_UNAVAILABLE` se a flag estiver desligada. */
  async assertEnabled(flag: string, accountId?: string): Promise<void> {
    if (!(await this.isEnabled(flag, accountId))) throw featureUnavailable(flag);
  }

  private async override(flag: string, accountId: string): Promise<boolean | null> {
    const key = `${flag}:${accountId}`;
    const hit = this.cache.get(key);
    const ttl = this.options.cacheTtlMs ?? 30_000;
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const row = (
      await sql<{ enabled: boolean }>`
        SELECT enabled FROM feature_flag_override WHERE flag = ${flag} AND account_id = ${accountId}`.execute(
        this.options.db!,
      )
    ).rows[0];
    const value = row ? row.enabled : null;
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }
}
