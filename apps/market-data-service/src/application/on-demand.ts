import { Instant } from '@broker/domain-kernel';
import { isIndex } from '../domain/quote.js';
import type { BudgetController } from './budget.js';
import { MarketDataError, type MarketDataDeps } from './context.js';
import type { ProviderHealth } from './errors.js';
import type { StoredQuote } from './ports.js';
import { ProviderError } from './provider.js';
import { quoteCacheKey, serializeQuote, type Quotes } from './quotes.js';
import { QueueTimeout, RequestDenied, type ProviderQueue } from './queue.js';

/** Validade do cache sob demanda em `SAVING` (Brapi §5.3). */
const SAVING_CACHE_MS = 2 * 3_600_000;

export interface ExternalQuoteView {
  quote: Record<string, unknown>;
  /** `PROVIDER` (lida agora), `CACHE` (Valkey) ou `STORED` (última gravada). */
  servedFrom: 'PROVIDER' | 'CACHE' | 'STORED';
  /** RN-BRP-006: "Fonte: brapi.dev" e o horário da cotação. */
  attribution: string;
  warning?: string;
}

/**
 * Consulta sob demanda de qualquer ticker (P3, RN-BRP-042/043): cache de 30 min (2 h em `SAVING`,
 * quando a fila nem é usada); senão uma requisição coalescida com espera de 5 s. Se o prazo estoura
 * ou o provedor falha, devolve a última gravada com aviso (RN-BRP-081).
 */
export class OnDemandQuotes {
  constructor(
    private readonly d: MarketDataDeps,
    private readonly queue: ProviderQueue,
    private readonly quotes: Quotes,
    private readonly budget: BudgetController,
    private readonly health: ProviderHealth,
  ) {}

  async get(symbol: string): Promise<ExternalQuoteView> {
    const now = this.d.clock.now();
    const maxAge = this.budget.level() === 'SAVING' ? SAVING_CACHE_MS : this.d.plan.onDemandCacheMs;
    const cached = await this.d.cache
      .get<Record<string, unknown>>(quoteCacheKey(symbol))
      .catch(() => null);
    if (cached && now.epochMillis - cached.storedAt.epochMillis <= maxAge)
      return this.view(cached.value, 'CACHE');

    let warning: string | undefined;
    try {
      const res = await this.queue.enqueue(
        {
          key: `quote:${symbol}`,
          symbol,
          kind: isIndex(symbol) ? 'INDEX_QUOTE' : 'ON_DEMAND_QUOTE',
          priority: 3,
          run: () => this.d.provider.getQuote(symbol),
        },
        { waitTimeoutMs: this.d.plan.onDemandWaitMs },
      );
      const r = await this.quotes.ingest(res);
      if (r.current) return this.view(serializeQuote(r.current), 'PROVIDER');
    } catch (err) {
      if (err instanceof ProviderError) {
        await this.health.report('ON_DEMAND_QUOTE', err, { symbol });
        if (err.kind === 'NOT_FOUND' && !cached && !(await this.stored(symbol)))
          throw new MarketDataError(404, 'QUOTE_NOT_FOUND', `Sem cotação para ${symbol}.`);
      } else if (!(err instanceof QueueTimeout) && !(err instanceof RequestDenied)) throw err;
      warning =
        err instanceof QueueTimeout
          ? 'Fonte lenta: exibindo a última cotação disponível.'
          : 'Fonte indisponível no momento: exibindo a última cotação disponível.';
    }
    if (cached) return this.view(cached.value, 'CACHE', warning);
    const stored = await this.stored(symbol);
    if (stored) return this.view(serializeQuote(stored), 'STORED', warning);
    throw new MarketDataError(
      503,
      'QUOTE_UNAVAILABLE',
      `Cotação de ${symbol} indisponível no momento.`,
    );
  }

  private stored(symbol: string): Promise<StoredQuote | null> {
    return this.d.store.transaction((tx) => tx.quote(symbol));
  }

  private view(
    q: Record<string, unknown>,
    servedFrom: ExternalQuoteView['servedFrom'],
    warning?: string,
  ): ExternalQuoteView {
    const quote = q['quote'] as { quoteTime: string };
    const at = Instant.parse(quote.quoteTime);
    return {
      quote: q,
      servedFrom,
      attribution: `Fonte: brapi.dev · ${at.toString()}`,
      ...(warning ? { warning } : {}),
    };
  }
}
