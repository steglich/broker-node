// Chamada do BFF a um serviço dono: repassa o token do usuário e os headers do comando (assinatura,
// idempotência, concorrência, correlação e trace) e devolve status, headers e corpo como vieram.
import { HttpError, type ExecutionContext } from '@broker/service-kit';
import type { Upstream } from './routes.js';

const TIMEOUT_MS = 15_000;

/** Headers do canal que o serviço dono precisa ver. */
const FORWARDED = [
  'authorization',
  'idempotency-key',
  'if-match',
  'x-trading-signature',
  'x-client-channel',
  'x-client-version',
  'x-forwarded-for',
  'traceparent',
  'tracestate',
  'user-agent',
  'accept-language',
] as const;

/** Headers da resposta do dono que voltam ao canal. */
const RETURNED = [
  'etag',
  'location',
  'retry-after',
  'idempotent-replayed',
  'deprecation',
  'sunset',
];

export interface UpstreamCall {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** Headers da requisição do canal (já com o `authorization` do cookie, se veio por ele). */
  headers: Record<string, string | string[] | undefined>;
  ctx: ExecutionContext;
  /** Headers extras (ex.: o token de assinatura tirado do cookie). */
  extra?: Record<string, string>;
}

export interface UpstreamResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export class Upstreams {
  constructor(private readonly urls: Record<Upstream, string>) {}

  async call(service: Upstream, c: UpstreamCall): Promise<UpstreamResult> {
    const headers = new Headers();
    for (const name of FORWARDED) {
      const v = c.headers[name];
      if (typeof v === 'string') headers.set(name, v);
    }
    headers.set('x-correlation-id', c.ctx.correlationId);
    for (const [k, v] of Object.entries(c.extra ?? {})) headers.set(k, v);
    const hasBody =
      c.body !== undefined && !['GET', 'HEAD', 'DELETE'].includes(c.method.toUpperCase());
    if (hasBody) headers.set('content-type', 'application/json');
    const qs = new URLSearchParams(c.query ?? {}).toString();
    let res: Response;
    try {
      res = await fetch(`${this.urls[service]}${c.path}${qs ? `?${qs}` : ''}`, {
        method: c.method.toUpperCase(),
        headers,
        ...(hasBody ? { body: JSON.stringify(c.body) } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Serviço temporariamente indisponível.', {
        headers: { 'Retry-After': '5' },
      });
    }
    const out: Record<string, string> = {};
    for (const name of RETURNED) {
      const v = res.headers.get(name);
      if (v) out[name] = v;
    }
    const text = await res.text();
    let body: unknown;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new HttpError(
          502,
          'BAD_UPSTREAM_RESPONSE',
          'Resposta inválida de um serviço interno.',
        );
      }
    }
    return { status: res.status, headers: out, body };
  }
}

/**
 * RN-API-043: em `/v1/me/...` a conta é a do token. Um `accountId` na consulta ou no corpo é
 * descartado antes de chegar ao dono (que também só usa o do token).
 */
export function stripAccount<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    if (!/^account_?id$/i.test(k)) out[k] = v;
  return out as T;
}
