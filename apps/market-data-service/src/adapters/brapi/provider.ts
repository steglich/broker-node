import type { Clock } from '@broker/clock';
import type { Logger } from '@broker/service-kit';
import { createHash } from 'node:crypto';
import type { ProviderUsage } from '../../domain/budget.js';
import type { ExternalQuote } from '../../domain/quote.js';
import {
  ProviderError,
  type CatalogPage,
  type DailyCandle,
  type MarketDataProvider,
  type ProviderCapabilities,
  type ProviderResult,
  type RawResponse,
  type SymbolResolution,
} from '../../application/provider.js';
import { mapCatalog, mapHistory, mapQuote, mapResolve, mapUsage } from './mapping.js';
import { fingerprint, type TokenSource } from './tokens.js';

export type FetchLike = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface BrapiProviderOptions {
  /** `https://brapi.dev/api` (TLS com validação de certificado, RN-BRP-093). */
  baseUrl: string;
  tokens: TokenSource;
  /** `brapi.tokenless_symbols`: PETR4, MGLU3, VALE3 e ITUB4 dispensam token (RN-BRP-034). */
  tokenlessSymbols: readonly string[];
  capabilities: Omit<ProviderCapabilities, 'tokenlessSymbols'>;
  clock: Clock;
  logger: Logger;
  /** Padrão: o `fetch` global (undici). Os testes e o provedor de fixtures trocam. */
  fetch?: FetchLike;
  /** Sem resposta em 10 s é tratado como `5xx` (Brapi §10). */
  timeoutMs?: number;
  name?: 'brapi' | 'fixture';
}

interface Call {
  endpoint: string;
  path: string;
  query: Record<string, string>;
  /** O endpoint aceita token (E2, E3, E9); E1/E6/E7 não exigem (Brapi §4). */
  auth: 'required' | 'optional' | 'none';
}

/**
 * Adaptador da brapi (Brapi §3–§4, §10). Só o market-data fala com a brapi (RN-BRP-001), e só por
 * aqui. Logs com a URL sem credenciais e sem cabeçalhos (RN-BRP-091): o token vai só no header
 * `Authorization` e nunca é escrito. Com dois tokens (rotação, RN-BRP-094), um `401` do primeiro
 * tenta o segundo antes de desistir.
 */
export class BrapiProvider implements MarketDataProvider {
  readonly name: 'brapi' | 'fixture';
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly tokenless: Set<string>;

  constructor(private readonly o: BrapiProviderOptions) {
    this.name = o.name ?? 'brapi';
    this.fetchFn = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.tokenless = new Set(o.tokenlessSymbols);
  }

  capabilities(): ProviderCapabilities {
    return { ...this.o.capabilities, tokenlessSymbols: [...this.tokenless] };
  }

  async listInstruments(page: number, limit: number): Promise<ProviderResult<CatalogPage>> {
    const raw = await this.call({
      endpoint: 'tickers',
      path: '/v2/tickers',
      query: { page: String(page), limit: String(limit) },
      auth: 'none',
    });
    return { value: mapCatalog(json(raw)), raw };
  }

  async getQuote(symbol: string): Promise<ProviderResult<ExternalQuote>> {
    const raw = await this.call({
      endpoint: 'stocks/quote',
      path: '/v2/stocks/quote',
      query: { symbols: symbol },
      auth: this.tokenless.has(symbol) ? 'none' : 'required',
    });
    return { value: withRaw(() => mapQuote(json(raw), symbol), raw), raw };
  }

  async getDailyHistory(symbol: string, range: string): Promise<ProviderResult<DailyCandle[]>> {
    const raw = await this.call({
      endpoint: 'stocks/historical',
      path: '/v2/stocks/historical',
      query: { symbols: symbol, range, interval: '1d' },
      auth: this.tokenless.has(symbol) ? 'optional' : 'required',
    });
    return { value: withRaw(() => mapHistory(json(raw), symbol), raw), raw };
  }

  async resolveSymbols(symbols: readonly string[]): Promise<ProviderResult<SymbolResolution[]>> {
    const raw = await this.call({
      endpoint: 'tickers/resolve',
      path: '/v2/tickers/resolve',
      query: { symbols: symbols.join(',') },
      auth: 'none',
    });
    return { value: withRaw(() => mapResolve(json(raw)), raw), raw };
  }

  async getUsage(): Promise<ProviderResult<ProviderUsage | null>> {
    const raw = await this.call({
      endpoint: 'user/usage',
      path: '/v2/user/usage',
      query: {},
      auth: 'required',
    });
    return { value: withRaw(() => mapUsage(json(raw)), raw), raw };
  }

  /** Impressão digital do token em uso (para a trava do `401`); `null` sem token. */
  async tokenFingerprint(): Promise<string | null> {
    const [first] = await this.o.tokens.tokens();
    return first ? fingerprint(first) : null;
  }

  private async call(c: Call): Promise<RawResponse> {
    const qs = new URLSearchParams(c.query).toString();
    const url = `${this.o.baseUrl}${c.path}${qs ? `?${qs}` : ''}`;
    const tokens = c.auth === 'none' ? [] : await this.o.tokens.tokens();
    // As fixtures dispensam token; a brapi real recusaria com 401 (sem gastar a requisição).
    if (c.auth === 'required' && tokens.length === 0 && this.name === 'brapi')
      throw new ProviderError('UNAUTHORIZED', `${c.endpoint}: sem token configurado`);
    const attempts: (string | null)[] = tokens.length ? tokens : [null];
    let last: RawResponse | undefined;
    for (const token of attempts) {
      last = await this.send(c, url, token);
      if (last.status !== 401) {
        if (token && tokens.length > 1) this.o.tokens.confirm(token);
        break;
      }
    }
    return this.classify(c, last!);
  }

  private async send(c: Call, url: string, token: string | null): Promise<RawResponse> {
    const started = performance.now();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let status = 0;
    try {
      const res = await this.fetchFn(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      const body = await res.text();
      const deprecated = res.headers.get('deprecation');
      return {
        endpoint: c.endpoint,
        url,
        status,
        body,
        sha256: createHash('sha256').update(body).digest('hex'),
        receivedAt: this.o.clock.now(),
        deprecation:
          deprecated && deprecated !== 'false'
            ? { sunset: res.headers.get('sunset'), link: res.headers.get('link') }
            : null,
        ...(status === 429 ? { retryAfter: res.headers.get('retry-after') } : {}),
      };
    } catch (err) {
      const timeout =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ProviderError(
        timeout ? 'TIMEOUT' : 'SERVER_ERROR',
        `${c.endpoint}: ${timeout ? `sem resposta em ${this.timeoutMs} ms` : 'falha de rede'}`,
      );
    } finally {
      // RN-BRP-091: URL sem credenciais, sem cabeçalhos; o token só aparece como impressão digital.
      this.o.logger.info(
        {
          event: 'brapi.request',
          provider: this.name,
          endpoint: c.endpoint,
          url,
          status,
          durationMs: Math.round(performance.now() - started),
          ...(token ? { tokenId: fingerprint(token) } : {}),
        },
        'requisição ao provedor de mercado',
      );
    }
  }

  private classify(c: Call, raw: RawResponse): RawResponse {
    const { status } = raw;
    if (status >= 200 && status < 300) return raw;
    const message = `${c.endpoint}: HTTP ${status}`;
    const details = { status, raw };
    if (status === 400) throw new ProviderError('BAD_REQUEST', message, details);
    if (status === 401) throw new ProviderError('UNAUTHORIZED', message, details);
    if (status === 403) throw new ProviderError('FORBIDDEN', message, details);
    if (status === 404) throw new ProviderError('NOT_FOUND', message, details);
    if (status === 429) {
      const retryAfter = raw.retryAfter ?? null;
      throw new ProviderError('RATE_LIMITED', message, {
        ...details,
        ...(retryAfter ? { retryAfterMs: parseRetryAfter(retryAfter, this.o.clock) } : {}),
        quota: /quota|cota|limite (mensal|do plano)|monthly|exceeded|esgot/i.test(raw.body),
      });
    }
    throw new ProviderError('SERVER_ERROR', message, details);
  }
}

function json(raw: RawResponse): unknown {
  try {
    return JSON.parse(raw.body);
  } catch {
    throw new ProviderError('INVALID_BODY', `${raw.endpoint}: JSON malformado`, {
      status: raw.status,
      raw,
    });
  }
}

/** Erro de mapeamento carrega o corpo bruto (para registrar, Brapi §10). */
function withRaw<T>(fn: () => T, raw: RawResponse): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ProviderError && !err.details.raw)
      throw new ProviderError(err.kind, err.message, { ...err.details, status: raw.status, raw });
    throw err;
  }
}

/** `Retry-After` em segundos ou data HTTP. */
function parseRetryAfter(v: string, clock: Clock): number {
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? 60_000 : Math.max(0, at - clock.now().epochMillis);
}
