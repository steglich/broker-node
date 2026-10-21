import { randomUUID } from 'node:crypto';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Espera uma condição assíncrona (consumidor processou, relay publicou…). Os efeitos em E2E são
 * eventualmente consistentes; o teste espera o efeito, nunca um `sleep` fixo.
 */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<void> {
  const { timeoutMs = 20_000, intervalMs = 50, what = 'condição' } = options;
  const deadline = performance.now() + timeoutMs;
  while (!(await condition())) {
    if (performance.now() > deadline)
      throw new Error(`tempo esgotado (${timeoutMs} ms) esperando ${what}`);
    await sleep(intervalMs);
  }
}

/** Como `waitUntil`, mas repete uma função que lança (ex.: um `expect`) até ela passar. */
export async function eventually<T>(
  attempt: () => T | Promise<T>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 20_000, intervalMs = 50 } = options;
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (performance.now() > deadline) throw err;
      await sleep(intervalMs);
    }
  }
}

export interface ApiResponse<B = unknown> {
  status: number;
  headers: Headers;
  body: B;
}

export interface ApiRequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Token de usuário ou serviço (`Authorization: Bearer`). */
  token?: string;
  /** `true` gera uma chave nova; uma string reaproveita a chave (teste de repetição, RN-API-010). */
  idempotencyKey?: true | string;
}

/**
 * Cliente HTTP para E2E e testes de componente. Toda chamada leva um `X-Correlation-Id` próprio,
 * que o teste usa para achar logs, eventos e traces do fluxo (RN-BE-011).
 */
export function apiClient(baseUrl: string, defaults: { token?: string } = {}) {
  async function request<B = unknown>(
    method: string,
    path: string,
    options: ApiRequestOptions = {},
  ): Promise<ApiResponse<B> & { correlationId: string }> {
    const correlationId = randomUUID();
    const headers: Record<string, string> = {
      accept: 'application/json, application/problem+json',
      'x-correlation-id': correlationId,
      ...options.headers,
    };
    const token = options.token ?? defaults.token;
    if (token) headers['authorization'] = `Bearer ${token}`;
    if (options.idempotencyKey) {
      headers['idempotency-key'] =
        options.idempotencyKey === true ? randomUUID() : options.idempotencyKey;
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    const body = (text && type.includes('json') ? JSON.parse(text) : text) as B;
    return { status: res.status, headers: res.headers, body, correlationId };
  }
  return {
    request,
    get: <B = unknown>(path: string, options?: ApiRequestOptions) =>
      request<B>('GET', path, options),
    post: <B = unknown>(path: string, body?: unknown, options: ApiRequestOptions = {}) =>
      request<B>('POST', path, { ...options, body }),
    put: <B = unknown>(path: string, body?: unknown, options: ApiRequestOptions = {}) =>
      request<B>('PUT', path, { ...options, body }),
    patch: <B = unknown>(path: string, body?: unknown, options: ApiRequestOptions = {}) =>
      request<B>('PATCH', path, { ...options, body }),
    delete: <B = unknown>(path: string, options?: ApiRequestOptions) =>
      request<B>('DELETE', path, options),
  };
}

export type ApiClient = ReturnType<typeof apiClient>;

/** Confere uma resposta de erro em Problem Details (RN-BE-030) e devolve o problema. */
export function assertProblem(
  res: ApiResponse,
  status: number,
  code: string,
): { code: string; status: number; correlationId: string; [k: string]: unknown } {
  const problem = res.body as { code?: unknown; status?: unknown; correlationId?: unknown };
  if (res.status !== status || problem.code !== code) {
    throw new Error(
      `esperado ${status} ${code}, recebido ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return res.body as { code: string; status: number; correlationId: string };
}
