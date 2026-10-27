// api-gateway (catálogo §22–24, D9): a borda HTTP. Atrás do Traefik (TLS); na frente dos BFFs.
import type { Clock } from '@broker/clock';
import {
  createService,
  forbidden,
  HttpError,
  type Authenticator,
  type BaseConfig,
  type ExecutionContext,
  type Logger,
  type Principal,
} from '@broker/service-kit';
import type { NextFunction, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import {
  bodyLimitFor,
  classify,
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
  DEFAULT_LIMITS,
  isChannel,
  parseVersion,
  progressiveDelayMs,
  REALM_OF,
  SECURITY_HEADERS,
  versionBelow,
  type Channel,
  type Limit,
} from './edge.js';
import type { RateDecision, RateLimiter } from './rate-limit.js';

/** Falhas de credencial contam por 15 min (RN-AUTH-002). */
const FAILURE_TTL_MS = 15 * 60_000;
const UPSTREAM_TIMEOUT_MS = 30_000;

/** Não passam adiante (RFC 9110 §7.6.1) nem voltam ao cliente. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'content-encoding',
]);

const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

export interface GatewayDeps {
  config: BaseConfig;
  clock: Clock;
  logger: Logger;
  authenticator: Authenticator;
  limiter: RateLimiter;
  /** URL base do BFF de cada canal; canal sem BFF → `503`. */
  bffs: Partial<Record<Channel, string>>;
  /** Versão mínima do app por canal (`426` abaixo dela). */
  minVersions?: Partial<Record<Channel, string>>;
  /** Origens dos canais web (RN-API-040): sem curinga. */
  allowedOrigins: readonly string[];
  /** Cookie do access token do token handler web (RN-AUTH-010). */
  accessCookie?: string;
  /** Prefixos com limite de corpo próprio (RN-API-042). */
  bodyLimits?: readonly { prefix: string; bytes: number }[];
  limits?: Partial<Record<keyof typeof DEFAULT_LIMITS, Limit>>;
  /** Proxies confiáveis à frente (o Traefik): o IP do cliente é o que eles anotaram. */
  trustedProxyHops?: number;
  /** Recusa HTTP simples vindo do proxy (`X-Forwarded-Proto: http`). Padrão: sim. */
  requireHttps?: boolean;
  sleep?: (ms: number) => Promise<void>;
  readiness?: Record<string, () => Promise<unknown>>;
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name)
      return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function createGateway(d: GatewayDeps) {
  const limits = { ...DEFAULT_LIMITS, ...d.limits };
  const accessCookie = d.accessCookie ?? '__Host-broker_at';
  const allowedOrigins = new Set(d.allowedOrigins);
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const service = createService({
    config: d.config,
    clock: d.clock,
    logger: d.logger,
    // O limite por rota é conferido abaixo; o parser só corta o absurdo.
    bodyLimit: `${Math.max(64 * 1024, ...(d.bodyLimits ?? []).map((b) => b.bytes))}b`,
    ...(d.readiness ? { readiness: d.readiness } : {}),
  });

  /** IP do cliente: o anotado pelo último proxy confiável, nunca o que o cliente escreveu. */
  const clientIp = (req: Request): string => {
    const chain = [
      ...(req.header('x-forwarded-for') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      req.socket.remoteAddress ?? 'unknown',
    ];
    const hops = d.trustedProxyHops ?? 0;
    return chain[Math.max(0, chain.length - 1 - hops)]!;
  };

  const rateHeaders = (res: Response, r: RateDecision) => {
    res.setHeader('RateLimit-Limit', String(r.limit));
    res.setHeader('RateLimit-Remaining', String(r.remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(r.resetMs / 1000)));
  };

  async function edge(req: Request, res: Response) {
    const ctx = res.locals['ctx'] as ExecutionContext;
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    // RN-API-001: o Traefik termina o TLS; HTTP que chegue até aqui volta para HTTPS.
    const proto = req.header('x-forwarded-proto')?.split(',')[0]?.trim();
    if ((d.requireHttps ?? true) && proto && proto !== 'https') {
      res.redirect(
        308,
        `https://${req.header('x-forwarded-host') ?? req.header('host')}${req.originalUrl}`,
      );
      return;
    }

    // RN-API-040: CORS só para as origens dos canais; origem desconhecida não ganha os headers.
    const origin = req.header('origin');
    const originAllowed = origin !== undefined && allowedOrigins.has(origin);
    if (origin) res.vary('Origin');
    if (originAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSED_HEADERS);
    }
    if (req.method === 'OPTIONS') {
      if (originAllowed) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
        res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
        res.setHeader('Access-Control-Max-Age', '600');
      }
      res.status(204).end();
      return;
    }
    // Comando vindo de um site de outra origem: nem chega ao BFF (defesa extra contra CSRF).
    if (origin && !originAllowed && !['GET', 'HEAD'].includes(req.method))
      throw forbidden('ORIGIN_NOT_ALLOWED', 'Origem não permitida.');

    // API §3: canal e versão em toda requisição; versão abaixo da mínima → 426.
    const channel = req.header('x-client-channel')?.toUpperCase();
    const version = req.header('x-client-version');
    if (!isChannel(channel) || !version || !parseVersion(version))
      throw new HttpError(
        400,
        'CLIENT_HEADERS_REQUIRED',
        'Envie X-Client-Channel (WEB, MOBILE, DESKTOP ou BACKOFFICE) e X-Client-Version (ex.: 1.4.0).',
      );
    const minimum = d.minVersions?.[channel];
    if (minimum && versionBelow(version, minimum))
      throw new HttpError(
        426,
        'UPGRADE_REQUIRED',
        `Esta versão do app (${version}) não é mais suportada. Atualize para a ${minimum} ou mais recente para continuar.`,
        { title: 'Atualize o aplicativo' },
      );

    // RN-API-042: 64 KB salvo exceções; corpo só em JSON (RN-API-002).
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const declared = Number(req.header('content-length') ?? 0);
    const size = raw?.length ?? declared;
    if (size > bodyLimitFor(req.path, d.bodyLimits ?? []))
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'O corpo passa do limite de 64 KB.');
    if (!raw && declared > 0)
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Envie o corpo em application/json.');

    const route = classify(req.method, req.path);
    let principal: Principal | undefined;
    if (!route.public) {
      // Web: o access token vem no cookie HttpOnly do token handler (RN-AUTH-010).
      const bearer = req.header('authorization');
      const cookie =
        channel === 'WEB' ? cookieValue(req.header('cookie'), accessCookie) : undefined;
      principal = await d.authenticator.authenticate(
        bearer ?? (cookie ? `Bearer ${cookie}` : undefined),
      );
      if (principal.actor.type === 'SERVICE' || principal.claims.realm !== REALM_OF[channel])
        throw forbidden('REALM_NOT_ALLOWED', 'Esta credencial não vale para este canal.');
    }

    // API §6: por IP nas públicas; por usuário em leituras, comandos e relatórios.
    const ip = clientIp(req);
    const now = d.clock.now().epochMillis;
    const checks: [string, Limit][] = principal
      ? [[`user:${principal.actor.id}:${route.bucket}`, limits[route.bucket]]]
      : [[`ip:${ip}:public`, limits.PUBLIC]];
    if (principal && route.report)
      checks.push([`user:${principal.actor.id}:report`, limits.REPORT]);
    const decisions = await Promise.all(
      checks.map(([key, l]) => d.limiter.hit(key, l.limit, l.windowMs, now)),
    );
    const denied = decisions.find((r) => !r.allowed);
    const shown = denied ?? decisions.reduce((a, b) => (b.remaining < a.remaining ? b : a));
    rateHeaders(res, shown);
    if (denied)
      throw new HttpError(429, 'RATE_LIMITED', 'Muitas requisições. Tente de novo em instantes.', {
        title: 'Limite de requisições atingido',
        headers: { 'Retry-After': String(Math.max(1, Math.ceil(denied.resetMs / 1000))) },
      });
    if (route.credentials) {
      const wait = progressiveDelayMs(await d.limiter.failures(ip));
      if (wait > 0) await sleep(wait);
    }

    const base = d.bffs[channel];
    if (!base)
      throw new HttpError(
        503,
        'CHANNEL_UNAVAILABLE',
        `O canal ${channel} ainda não está disponível.`,
      );

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k)) continue;
      for (const value of Array.isArray(v) ? v : [v]) headers.append(k, value);
    }
    headers.set('x-correlation-id', ctx.correlationId);
    const incomingTrace = req.header('traceparent');
    headers.set(
      'traceparent',
      incomingTrace && TRACEPARENT.test(incomingTrace)
        ? incomingTrace
        : `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`,
    );
    headers.set('x-forwarded-for', ip);
    headers.set('x-forwarded-proto', 'https');
    headers.set('x-client-channel', channel);

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${base}${req.originalUrl}`, {
        method: req.method,
        headers,
        ...(raw && raw.length > 0 ? { body: raw } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      d.logger.warn({ event: 'gateway.upstream_failed', channel, err }, 'BFF indisponível');
      throw new HttpError(503, 'BFF_UNAVAILABLE', 'Serviço temporariamente indisponível.', {
        headers: { 'Retry-After': '5' },
      });
    }

    if (route.credentials) {
      if (upstream.status === 401) await d.limiter.recordFailure(ip, FAILURE_TTL_MS);
      else if (upstream.ok) await d.limiter.clearFailures(ip);
    }

    upstream.headers.forEach((value, key) => {
      if (HOP_BY_HOP.has(key) || key === 'set-cookie' || key === 'x-correlation-id') return;
      res.setHeader(key, value);
    });
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length > 0) res.setHeader('Set-Cookie', cookies);
    res.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
  }

  service.use((req: Request, res: Response, next: NextFunction) => {
    edge(req, res).catch(next);
  });
  return { service };
}
