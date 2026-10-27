import type { BusinessDate, Instant } from '@broker/domain-kernel';
import type { ProviderUsage } from '../domain/budget.js';
import type { ExternalQuote } from '../domain/quote.js';

/**
 * Porta genérica do provedor de dados de mercado (Brapi §13, RN-BRP-003). A brapi é um adaptador
 * entre outros (fixtures, replay e, na Fase 7, o sintético). Tudo o que sai daqui já está no
 * modelo interno: nenhum nome de campo da brapi atravessa a porta (RN-BRP-002).
 */
export interface MarketDataProvider {
  readonly name: 'brapi' | 'fixture' | 'replay';
  capabilities(): ProviderCapabilities;
  /** E1: catálogo paginado (página começa em 1). */
  listInstruments(page: number, limit: number): Promise<ProviderResult<CatalogPage>>;
  /** E2: cotação de um símbolo (instrumento ou índice, ex.: `^BVSP`). */
  getQuote(symbol: string): Promise<ProviderResult<ExternalQuote>>;
  /** E3: candles diários do período (`range` dentro de `max_history_range`). */
  getDailyHistory(symbol: string, range: string): Promise<ProviderResult<DailyCandle[]>>;
  /** E6: símbolo atual, status, data e razão de conversão (até 20 por chamada). */
  resolveSymbols(symbols: readonly string[]): Promise<ProviderResult<SymbolResolution[]>>;
  /** E9: consumo e janela; `null` para provedores sem cota (fixtures, replay). */
  getUsage(): Promise<ProviderResult<ProviderUsage | null>>;
}

export interface ProviderCapabilities {
  symbolsPerRequest: number;
  maxHistoryRange: string;
  allowedIntervals: readonly string[];
  dividends: boolean;
  /** Tickers que dispensam token (`brapi.tokenless_symbols`, RN-BRP-034). */
  tokenlessSymbols: readonly string[];
  /** Consome cota (só a brapi real): sem isso o orçamento não se aplica. */
  metered: boolean;
}

/** Resultado com o corpo bruto (para o hash, o MinIO e o replay, RN-BRP-060/061). */
export interface ProviderResult<T> {
  value: T;
  raw: RawResponse;
}

export interface RawResponse {
  endpoint: string;
  /** URL sem credenciais (RN-BRP-091). */
  url: string;
  status: number;
  body: string;
  sha256: string;
  receivedAt: Instant;
  /** Cabeçalhos de descontinuação (Brapi §10): `Deprecation`, `Sunset`, `Link`. */
  deprecation: { sunset: string | null; link: string | null } | null;
  /** `Retry-After` de um `429`. */
  retryAfter?: string | null;
}

export interface CatalogEntry {
  symbol: string;
  shortName: string | null;
  longName: string | null;
  assetType: 'STOCK' | 'UNIT' | 'REIT' | 'ETF' | 'BDR';
  sector: string | null;
  logoUrl: string | null;
}

export interface CatalogPage {
  entries: CatalogEntry[];
  /** Índices listados pela fonte (ex.: `^BVSP`), só para exibição (RN-MD-020). */
  indexes: { symbol: string; name: string }[];
  /** Itens fora do modelo interno (fundos sem tipo suportado, tickers fora do padrão). */
  skipped: number;
  hasNextPage: boolean;
}

/** Candle diário externo (`external_daily_candle`). */
export interface DailyCandle {
  date: BusinessDate;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Use para retornos (Brapi §9.1). */
  adjustedClose: string | null;
  volume: string;
}

export interface SymbolResolution {
  requestedSymbol: string;
  symbol: string;
  status: 'ACTIVE' | 'RENAMED';
  effectiveDate: string | null;
  conversionRatio: string | null;
}

/** Falhas do provedor, já classificadas (Brapi §10). */
export type ProviderErrorKind =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'INVALID_BODY';

export class ProviderError extends Error {
  override readonly name = 'ProviderError';

  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly details: {
      status?: number;
      /** `Retry-After` em ms (429). */
      retryAfterMs?: number;
      /** 429 por cota esgotada (e não por concorrência). */
      quota?: boolean;
      raw?: RawResponse;
    } = {},
  ) {
    super(message);
  }

  /** `5xx` e timeout: contam para o disjuntor e têm retentativa com backoff (RN-BRP-080). */
  get transient(): boolean {
    return this.kind === 'SERVER_ERROR' || this.kind === 'TIMEOUT';
  }

  /** A requisição chegou à fonte e pode ter consumido cota (RN-BRP-032). */
  get reachedProvider(): boolean {
    return this.kind !== 'TIMEOUT' && this.details.status !== undefined;
  }
}
