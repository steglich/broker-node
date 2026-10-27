import type { Clock } from '@broker/clock';
import type { Instant } from '@broker/domain-kernel';
import { createHash } from 'node:crypto';
import type { ProviderUsage } from '../domain/budget.js';
import type { ExternalQuote } from '../domain/quote.js';
import {
  ProviderError,
  type CatalogPage,
  type DailyCandle,
  type MarketDataProvider,
  type ProviderCapabilities,
  type ProviderResult,
  type RawResponse,
  type SymbolResolution,
} from '../application/provider.js';

/** Leituras gravadas em `external_quote_history` (RN-BRP-060). */
export interface ReplaySource {
  readingAt(symbol: string, at: Instant): Promise<ExternalQuote | null>;
}

export interface ReplayProviderOptions {
  source: ReplaySource;
  clock: Clock;
  /**
   * Deslocamento do replay: a leitura servida agora é a que valia em `agora − offset`, com o
   * horário da cotação trazido para o presente (padrão 7 dias: o mesmo horário da semana passada).
   */
  offsetMs: number;
  /** Catálogo, histórico e resolução (sem leituras gravadas): normalmente o provedor de fixtures. */
  fallback: MarketDataProvider;
}

/**
 * Provedor de replay (Brapi §13): reproduz as cotações reais já gravadas, sem chamada à brapi e
 * sem cota (ambiente local, testes de regressão e carga). Funciona pela mesma porta: trocar o
 * provedor é configuração (RN-BRP-003, RN-BRP-095).
 */
export class ReplayProvider implements MarketDataProvider {
  readonly name = 'replay' as const;

  constructor(private readonly o: ReplayProviderOptions) {}

  capabilities(): ProviderCapabilities {
    return { ...this.o.fallback.capabilities(), metered: false };
  }

  async getQuote(symbol: string): Promise<ProviderResult<ExternalQuote>> {
    const now = this.o.clock.now();
    const recorded = await this.o.source.readingAt(symbol, now.plusMillis(-this.o.offsetMs));
    if (!recorded) throw new ProviderError('NOT_FOUND', `replay: sem leitura gravada de ${symbol}`);
    const quote: ExternalQuote = {
      ...recorded,
      quoteTime: recorded.quoteTime.plusMillis(this.o.offsetMs),
    };
    const body = JSON.stringify({ ...quote, quoteTime: quote.quoteTime.toString() });
    const raw: RawResponse = {
      endpoint: 'replay/quote',
      url: `replay://quote/${encodeURIComponent(symbol)}`,
      status: 200,
      body,
      sha256: createHash('sha256').update(body).digest('hex'),
      receivedAt: now,
      deprecation: null,
    };
    return { value: quote, raw };
  }

  listInstruments(page: number, limit: number): Promise<ProviderResult<CatalogPage>> {
    return this.o.fallback.listInstruments(page, limit);
  }

  getDailyHistory(symbol: string, range: string): Promise<ProviderResult<DailyCandle[]>> {
    return this.o.fallback.getDailyHistory(symbol, range);
  }

  resolveSymbols(symbols: readonly string[]): Promise<ProviderResult<SymbolResolution[]>> {
    return this.o.fallback.resolveSymbols(symbols);
  }

  async getUsage(): Promise<ProviderResult<ProviderUsage | null>> {
    const raw: RawResponse = {
      endpoint: 'replay/usage',
      url: 'replay://usage',
      status: 200,
      body: 'null',
      sha256: createHash('sha256').update('null').digest('hex'),
      receivedAt: this.o.clock.now(),
      deprecation: null,
    };
    return { value: null, raw };
  }
}
