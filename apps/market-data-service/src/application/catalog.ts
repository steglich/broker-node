import type { Instant } from '@broker/domain-kernel';
import type { MarketDataDeps } from './context.js';
import type { ProviderHealth } from './errors.js';
import type { CatalogEntry, DailyCandle } from './provider.js';
import type { ProviderQueue } from './queue.js';

const DAY = 86_400_000;
/** Tamanho dos lotes do `catalog_synced` (o payload tem teto de 256 KiB, RN-MSG-B-014). */
const CATALOG_CHUNK = 500;
/** E6: até 20 símbolos por chamada (Brapi §4). */
const RESOLVE_BATCH = 20;
/** Nova tentativa da carga inicial do histórico depois de uma falha. */
const BACKFILL_RETRY_MS = 600_000;

export interface CatalogStats {
  pages: number;
  received: number;
  skipped: number;
  newSymbols: number;
  inactiveSymbols: number;
  events: number;
  renames: number;
}

/**
 * Catálogo diário (E1, 06:30) e resolução de tickers (E6) do universo (Brapi §4, RN-INS-010/030):
 * publica `market_data.catalog_synced` com os tickers novos e os que saíram da fonte (o
 * reference-data cadastra com `tradable = false`) e `market_data.symbol_rename_detected` uma vez
 * por renomeação. Histórico diário (E3) com cache de 24 h, ao entrar no universo ou sob demanda.
 */
export class Catalog {
  /** Última falha do catálogo do dia: nova tentativa só depois de `BACKFILL_RETRY_MS`. */
  private syncFailedAt: number | undefined;
  /** Última tentativa de carga por símbolo: uma falha não vira uma requisição por rodada. */
  private readonly backfillTried = new Map<string, number>();

  constructor(
    private readonly d: MarketDataDeps,
    private readonly queue: ProviderQueue,
    private readonly health: ProviderHealth,
  ) {}

  /**
   * Catálogo do dia (Brapi §4: 1×/dia às 06:30, antes da abertura). Job do próprio serviço, uma vez
   * por data de negócio (`provider_job_run`); se falhar, a data é liberada para nova tentativa.
   */
  async syncIfDue(at = '06:30'): Promise<CatalogStats | null> {
    const now = this.d.clock.now();
    const date = now.businessDate();
    try {
      if (!this.d.calendar.isBusinessDay(date)) return null;
    } catch {
      return null;
    }
    if (now.isBefore(date.atLocalTime(at))) return null;
    if (this.syncFailedAt !== undefined && now.epochMillis - this.syncFailedAt < BACKFILL_RETRY_MS)
      return null;
    const period = date.toString();
    const claimed = await this.d.store.transaction((tx) =>
      tx.claimPeriodicRun('brapi_catalog_sync', period, now),
    );
    if (!claimed) return null;
    try {
      const stats = await this.sync();
      this.syncFailedAt = undefined;
      return stats;
    } catch (err) {
      this.syncFailedAt = now.epochMillis;
      await this.d.store.transaction((tx) => tx.releasePeriodicRun('brapi_catalog_sync', period));
      throw err;
    }
  }

  async sync(): Promise<CatalogStats> {
    const entries = new Map<string, CatalogEntry>();
    let page = 1;
    let skipped = 0;
    for (;;) {
      const current = page;
      const res = await this.queue
        .enqueue({
          key: `catalog:${current}`,
          kind: 'CATALOG',
          priority: 5,
          run: () => this.d.provider.listInstruments(current, this.d.plan.catalogPageSize),
        })
        .catch(async (err: unknown) => {
          await this.health.report('CATALOG', err, { page: current });
          throw err;
        });
      for (const e of res.value.entries) entries.set(e.symbol, e);
      skipped += res.value.skipped;
      if (!res.value.hasNextPage) break;
      page++;
    }
    const now = this.d.clock.now();
    const { added, inactive, events } = await this.d.store.transaction(async (tx) => {
      const known = await tx.catalogSymbols();
      const added = [...entries.values()].filter(
        (e) => !known.has(e.symbol) || known.get(e.symbol) === false,
      );
      const inactive = [...known.entries()]
        .filter(([s, active]) => active && !entries.has(s))
        .map(([s]) => s);
      await tx.upsertCatalog([...entries.values()], now);
      await tx.deactivateCatalog(inactive, now);
      let events = 0;
      const chunks = Math.max(
        1,
        Math.ceil(Math.max(added.length, inactive.length) / CATALOG_CHUNK),
      );
      for (let i = 0; i < chunks; i++) {
        await tx.publish(
          {
            type: 'market_data.catalog_synced',
            payload: {
              newSymbols: added.slice(i * CATALOG_CHUNK, (i + 1) * CATALOG_CHUNK),
              inactiveSymbols: inactive.slice(i * CATALOG_CHUNK, (i + 1) * CATALOG_CHUNK),
              syncedAt: now.toString(),
            },
          },
          'catalog',
        );
        events++;
      }
      return { added, inactive, events };
    });
    const renames = await this.resolveUniverse().catch(() => 0);
    return {
      pages: page,
      received: entries.size,
      skipped,
      newSymbols: added.length,
      inactiveSymbols: inactive.length,
      events,
      renames,
    };
  }

  /** E6 para o universo (e para um ticker que a cotação devolveu com `changed = true`). */
  async resolveUniverse(extra: readonly string[] = []): Promise<number> {
    const symbols = await this.d.store.transaction(async (tx) => [
      ...new Set([...(await tx.tradableInstruments()).map((i) => i.symbol), ...extra]),
    ]);
    let renames = 0;
    for (let i = 0; i < symbols.length; i += RESOLVE_BATCH) {
      const batch = symbols.slice(i, i + RESOLVE_BATCH);
      const res = await this.queue
        .enqueue({
          key: `resolve:${batch.join(',')}`,
          kind: 'RESOLVE',
          priority: 5,
          run: () => this.d.provider.resolveSymbols(batch),
        })
        .catch(async (err: unknown) => {
          await this.health.report('RESOLVE', err, { symbols: batch });
          return null;
        });
      if (!res) continue;
      await this.d.store.transaction(async (tx) => {
        for (const r of res.value) {
          if (r.status !== 'RENAMED' || r.symbol === r.requestedSymbol) continue;
          if (!(await tx.markRenameSeen(r.requestedSymbol, r.symbol))) continue;
          await tx.publish(
            {
              type: 'market_data.symbol_rename_detected',
              payload: {
                oldSymbol: r.requestedSymbol,
                newSymbol: r.symbol,
                effectiveDate: r.effectiveDate ?? this.d.clock.now().businessDate().toString(),
                ...(r.conversionRatio ? { conversionRatio: r.conversionRatio } : {}),
              },
            },
            r.requestedSymbol,
          );
          renames++;
        }
      });
    }
    return renames;
  }

  /**
   * Histórico diário (E3) com cache de 24 h (Brapi §7). `force` busca mesmo com o cache válido
   * (entrada no universo). Em `SAVING`, a fila recusa e fica o que está gravado.
   */
  async history(
    symbol: string,
    opts: { force?: boolean } = {},
  ): Promise<{
    candles: DailyCandle[];
    fetchedAt: Instant | null;
    fromCache: boolean;
    warning?: string;
  }> {
    const now = this.d.clock.now();
    const fetchedAt = await this.d.store.transaction((tx) => tx.historyFetchedAt(symbol));
    const fresh = fetchedAt !== null && now.epochMillis - fetchedAt.epochMillis < DAY;
    let warning: string | undefined;
    if (!fresh || opts.force) {
      try {
        const res = await this.queue.enqueue({
          key: `history:${symbol}`,
          symbol,
          kind: 'HISTORY',
          priority: 4,
          run: () => this.d.provider.getDailyHistory(symbol, this.d.plan.maxHistoryRange),
        });
        await this.d.store.transaction(async (tx) => {
          await tx.upsertCandles(symbol, res.value, 'HISTORY');
          await tx.markHistoryFetched(symbol, now);
        });
        return { candles: await this.candles(symbol), fetchedAt: now, fromCache: false };
      } catch (err) {
        await this.health.report('HISTORY', err, { symbol });
        warning = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      candles: await this.candles(symbol),
      fetchedAt,
      fromCache: true,
      ...(warning ? { warning } : {}),
    };
  }

  /**
   * Carga inicial do histórico de quem entrou no universo (Brapi §4, E3) e ainda não tem: o laço do
   * líder chama, fora da transação do consumidor de `instrument.tradability_changed`.
   */
  async backfillHistory(): Promise<number> {
    const pending = await this.d.store.transaction(async (tx) => {
      const out: string[] = [];
      for (const i of await tx.tradableInstruments())
        if (!(await tx.historyFetchedAt(i.symbol))) out.push(i.symbol);
      return out;
    });
    const now = this.d.clock.now().epochMillis;
    let n = 0;
    for (const symbol of pending) {
      const tried = this.backfillTried.get(symbol);
      if (tried !== undefined && now - tried < BACKFILL_RETRY_MS) continue;
      this.backfillTried.set(symbol, now);
      await this.history(symbol, { force: true });
      n++;
    }
    return n;
  }

  private async candles(symbol: string): Promise<DailyCandle[]> {
    return this.d.store.transaction((tx) => tx.candles(symbol));
  }
}
