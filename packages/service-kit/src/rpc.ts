import CircuitBreaker from 'opossum';
import { Pool } from 'undici';
import type { ServiceTokenProvider } from './auth.js';
import { currentContext } from './context.js';
import { HttpError, serviceUnavailable } from './errors.js';

export interface RpcClientOptions {
  /** Nome da dependência (ex.: `risk`): vira o código `RISK_UNAVAILABLE`. */
  name: string;
  baseUrl: string;
  /** Timeout explícito por chamada (D11: pré-trade 200 ms). */
  timeoutMs: number;
  tokenProvider?: ServiceTokenProvider;
  /** Conexões máximas para a dependência: o *bulkhead* (D11). Padrão 10. */
  connections?: number;
  /** Novas tentativas, só em operação idempotente (RN-ARQ-002). Padrão 2. */
  retries?: number;
  breaker?: {
    /** % de falhas na janela que abre o disjuntor (padrão 50). */
    errorThresholdPercentage?: number;
    /** Chamadas mínimas na janela antes de avaliar (padrão 5). */
    volumeThreshold?: number;
    /** Tempo aberto antes da meia-abertura (padrão 10 s). */
    resetTimeoutMs?: number;
    rollingCountTimeoutMs?: number;
  };
}

export interface RpcRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  /** Chave de idempotência: torna um POST seguro para repetir. */
  idempotencyKey?: string;
}

export interface RpcResponse<T> {
  status: number;
  body: T;
}

/** Resposta 4xx da dependência: é resultado, não falha de disponibilidade (não abre o disjuntor). */
export class RpcClientError extends Error {
  override readonly name = 'RpcClientError';

  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`dependência respondeu ${status}`);
  }
}

/**
 * Cliente RPC interno (D11, RN-ARQ-002, RN-API-050): HTTP/JSON com `undici` (pool com keep-alive e
 * limite de conexões), timeout explícito, token de serviço, correlação, disjuntor (`opossum`) e
 * retentativa limitada só para operações idempotentes. Com o disjuntor aberto, falha na hora com
 * `503 <NOME>_UNAVAILABLE`, sem esperar o timeout.
 */
export class RpcClient {
  private readonly pool: Pool;
  readonly breaker: CircuitBreaker<[RpcRequest], RpcResponse<unknown>>;

  constructor(private readonly options: RpcClientOptions) {
    this.pool = new Pool(options.baseUrl, {
      connections: options.connections ?? 10,
      keepAliveTimeout: 30_000,
    });
    const b = options.breaker ?? {};
    this.breaker = new CircuitBreaker((req: RpcRequest) => this.send(req), {
      timeout: false, // o timeout é do undici/AbortSignal, por tentativa
      errorThresholdPercentage: b.errorThresholdPercentage ?? 50,
      volumeThreshold: b.volumeThreshold ?? 5,
      resetTimeout: b.resetTimeoutMs ?? 10_000,
      rollingCountTimeout: b.rollingCountTimeoutMs ?? 10_000,
      errorFilter: (err: unknown) => err instanceof RpcClientError,
    });
  }

  get unavailableCode(): string {
    return `${this.options.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_UNAVAILABLE`;
  }

  async call<T>(req: RpcRequest): Promise<RpcResponse<T>> {
    const idempotent =
      req.method === 'GET' ||
      req.method === 'PUT' ||
      req.method === 'DELETE' ||
      req.idempotencyKey !== undefined;
    const attempts = 1 + (idempotent ? (this.options.retries ?? 2) : 0);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return (await this.breaker.fire(req)) as RpcResponse<T>;
      } catch (err) {
        if (err instanceof RpcClientError) throw err;
        lastError = err;
        if (this.breaker.opened) break; // disjuntor aberto: não adianta repetir
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 25 * attempt));
      }
    }
    throw serviceUnavailable(
      this.unavailableCode,
      `Dependência ${this.options.name} indisponível: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  async close(): Promise<void> {
    this.breaker.shutdown();
    await this.pool.close();
  }

  private async send(req: RpcRequest): Promise<RpcResponse<unknown>> {
    const ctx = currentContext();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    if (ctx) headers['x-correlation-id'] = ctx.correlationId;
    if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;
    if (this.options.tokenProvider)
      headers['authorization'] = `Bearer ${await this.options.tokenProvider.token()}`;

    const res = await this.pool.request({
      method: req.method,
      path: req.path,
      headers,
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      headersTimeout: this.options.timeoutMs,
      bodyTimeout: this.options.timeoutMs,
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    const text = await res.body.text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    if (res.statusCode >= 500)
      throw new HttpError(503, this.unavailableCode, `dependência respondeu ${res.statusCode}`);
    if (res.statusCode >= 400) throw new RpcClientError(res.statusCode, body);
    return { status: res.statusCode, body };
  }
}
