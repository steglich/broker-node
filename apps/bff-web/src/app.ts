// bff-web (catálogo §22–24, D9): token handler do canal web e agregação/repasse das rotas da Fase 1.
import type { Clock } from '@broker/clock';
import { AuditPersonalDataAccessedV1 } from '@broker/contracts/events/audit.personal_data_accessed/v1';
import { bffWebHttp } from '@broker/contracts/http/bff-web';
import {
  connectStream,
  ensureSuperStream,
  EventPublisher,
  OutboxRelay,
  PartitionedProducer,
  topicName,
  type StreamSettings,
} from '@broker/messaging';
import { inTransaction, type DatabaseConfig } from '@broker/persistence';
import {
  createService,
  forbidden,
  type Authenticator,
  type BaseConfig,
  type ExecutionContext,
  type HandlerResult,
  type Logger,
  type RouteRequest,
} from '@broker/service-kit';
import type { NextFunction, Request, Response } from 'express';
import { sql, type Kysely } from 'kysely';
import { ROUTES, type ForwardRoute, type Upstream } from './routes.js';
import { COOKIES, parseCookies, TokenHandler, type HandlerOut } from './session.js';
import { stripAccount, Upstreams } from './upstream.js';

const r = bffWebHttp.routes;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Sem sessão ainda (ou saindo dela): o SameSite=Strict basta; o resto exige o anti-CSRF. */
const CSRF_EXEMPT =
  /^\/v1\/auth\/(login|register|logout|token\/refresh|mfa\/.+|password-reset(\/.+)?)$/;

export interface BffWebDeps {
  config: BaseConfig;
  clock: Clock;
  logger: Logger;
  db: Kysely<unknown>;
  database: DatabaseConfig;
  newId: () => string;
  authenticator: Authenticator;
  upstreams: Record<Upstream, string>;
  clientId: string;
  redirectUri: string;
  csrfSecret: Buffer;
  loginKey: Buffer;
  stream?: StreamSettings;
}

type Req = RouteRequest<unknown, unknown, unknown>;

export async function createBffWeb(d: BffWebDeps) {
  const environment = d.config.ENVIRONMENT;
  const upstreams = new Upstreams(d.upstreams);
  const tokens = new TokenHandler({
    upstreams,
    clientId: d.clientId,
    redirectUri: d.redirectUri,
    csrfSecret: d.csrfSecret,
    loginKey: d.loginKey,
  });
  const publisher = new EventPublisher({
    source: d.config.SERVICE_NAME,
    environment,
    clock: d.clock,
    newId: d.newId,
  });

  /** Segurança de aplicação §3: leitura de dado pessoal vira `audit.personal_data_accessed`. */
  const audit = (ctx: ExecutionContext, route: string, resourceType: string) =>
    inTransaction(d.db, (trx) =>
      publisher.publish(
        trx,
        AuditPersonalDataAccessedV1,
        {
          resourceType,
          resourceId: ctx.actor.id,
          route,
          channel: 'WEB',
          ...(ctx.ip ? { ip: ctx.ip } : {}),
          ...(ctx.userAgent ? { userAgent: ctx.userAgent.slice(0, 300) } : {}),
        },
        {
          partitionKey: ctx.actor.id,
          aggregateType: 'audit',
          aggregateId: ctx.actor.id,
          actor: ctx.actor,
          correlationId: ctx.correlationId,
        },
      ),
    );

  let relay: OutboxRelay | undefined;
  let closeStream: (() => Promise<void>) | undefined;
  if (d.stream) {
    const client = await connectStream(d.stream, d.config.SERVICE_NAME);
    closeStream = () => client.close();
    const superStream = topicName(environment, 'bff-web');
    await ensureSuperStream(client, superStream, { maxAge: '30D' });
    relay = new OutboxRelay({
      db: d.db,
      listenConfig: d.database,
      producer: await PartitionedProducer.create(
        client,
        superStream,
        `${d.config.SERVICE_NAME}.outbox`,
      ),
      clock: d.clock,
      onError: (err) => d.logger.error({ event: 'outbox.relay_failed', err }, 'falha no relay'),
    });
  }

  const service = createService({
    config: d.config,
    clock: d.clock,
    logger: d.logger,
    authenticator: d.authenticator,
    readiness: { database: () => sql`SELECT 1`.execute(d.db) },
  });

  // RN-AUTH-010: o access token chega no cookie HttpOnly; com ele, todo comando exige o anti-CSRF.
  // Um `Authorization: Bearer` explícito não é enviado sozinho pelo navegador, então dispensa.
  service.use((req: Request, res: Response, next: NextFunction) => {
    const cookies = parseCookies(req.header('cookie'));
    res.locals['cookies'] = cookies;
    const access = cookies[COOKIES.access];
    if (!req.headers.authorization && access) {
      req.headers.authorization = `Bearer ${access}`;
      if (
        !SAFE_METHODS.has(req.method) &&
        !CSRF_EXEMPT.test(req.path) &&
        !tokens.checkCsrf(access, req.header('x-csrf-token'))
      ) {
        next(forbidden('CSRF_TOKEN_INVALID', 'Envie o X-CSRF-Token da sessão.'));
        return;
      }
    }
    next();
  });

  const cookiesOf = (q: Req) => (q.raw.res!.locals['cookies'] ?? {}) as Record<string, string>;
  const reqOf = (q: Req, ctx: ExecutionContext) => ({ headers: q.headers, ctx });
  /** Grava os cookies e devolve o corpo (ou o erro) do token handler. */
  const respond = (q: Req, out: HandlerOut): HandlerResult => {
    for (const c of out.cookies) q.raw.res!.append('Set-Cookie', c);
    if (out.error) throw out.error;
    return {
      status: out.status,
      ...(out.body !== undefined ? { body: out.body } : {}),
      ...(out.headers ? { headers: out.headers } : {}),
    };
  };

  // ---------------------------------------------------------------- token handler
  service.route({
    method: 'post',
    path: '/v1/auth/login',
    auth: 'public',
    idempotent: false,
    validate: { body: r.login.body },
    handler: async (q, ctx) => respond(q, await tokens.login(q.body, cookiesOf(q), reqOf(q, ctx))),
  });
  service.route({
    method: 'post',
    path: '/v1/auth/mfa/verify',
    auth: 'public',
    idempotent: false,
    validate: { body: r.mfaVerify.body },
    handler: async (q, ctx) =>
      respond(
        q,
        await tokens.verifyMfa(q.body as Record<string, unknown>, cookiesOf(q), reqOf(q, ctx)),
      ),
  });
  service.route({
    method: 'post',
    path: '/v1/auth/mfa/webauthn-options',
    auth: 'public',
    idempotent: false,
    handler: async (q, ctx) =>
      respond(q, await tokens.webauthnOptions(cookiesOf(q), reqOf(q, ctx))),
  });
  service.route({
    method: 'post',
    path: '/v1/auth/token/refresh',
    auth: 'public',
    idempotent: false,
    handler: async (q, ctx) => respond(q, await tokens.refresh(cookiesOf(q), reqOf(q, ctx))),
  });
  service.route({
    method: 'post',
    path: '/v1/auth/logout',
    auth: 'public',
    idempotent: false,
    handler: async (q, ctx) => respond(q, await tokens.logout(cookiesOf(q), reqOf(q, ctx))),
  });
  service.route({
    method: 'get',
    path: '/v1/auth/session',
    auth: { principal: 'user' },
    handler: async (q, ctx) => {
      const auth = q.headers.authorization!.replace(/^Bearer\s+/i, '');
      const claims = JSON.parse(Buffer.from(auth.split('.')[1]!, 'base64url').toString()) as {
        exp: number;
      };
      return {
        body: {
          userId: ctx.actor.id,
          accountId: ctx.accountId ?? null,
          csrfToken: tokens.csrfFor(ctx.sessionId ?? ''),
          expiresAt: new Date(claims.exp * 1000).toISOString(),
        },
      };
    },
  });
  service.route({
    method: 'post',
    path: '/v1/me/step-up',
    auth: { principal: 'user' },
    idempotent: false,
    validate: { body: r.stepUp.body },
    handler: async (q, ctx) => respond(q, await tokens.stepUp(q.body, reqOf(q, ctx))),
  });
  service.route({
    method: 'post',
    path: '/v1/me/trading-signature/verify',
    auth: { principal: 'user' },
    idempotent: false,
    validate: { body: r.verifySignature.body },
    handler: async (q, ctx) =>
      respond(q, await tokens.verifySignature(q.body, reqOf(q, ctx), d.clock.now().epochMillis)),
  });

  // ---------------------------------------------------------------- agregação
  // Painel inicial: um pedido por dono, em paralelo (sem N+1); o que falhar vem null.
  service.route({
    method: 'get',
    path: '/v1/me',
    auth: { principal: 'user' },
    handler: async (q, ctx) => {
      const call = (service: Upstream, path: string, query?: Record<string, string>) =>
        upstreams.call(service, {
          method: 'get',
          path,
          headers: q.headers,
          ctx,
          ...(query ? { query } : {}),
        });
      const [profile, balances, notifications] = await Promise.allSettled([
        call('customer', '/v1/me/profile'),
        call('ledger', '/v1/me/balances'),
        call('notification', '/v1/me/notifications', { limit: '1', unread: 'true' }),
      ]);
      const unavailable: string[] = [];
      const ok = (name: string, s: PromiseSettledResult<{ status: number; body: unknown }>) => {
        if (s.status === 'fulfilled' && s.value.status === 200) return s.value.body;
        // 404 é "ainda não existe" (cadastro em andamento, conta sem ledger); o resto, indisponível.
        if (s.status === 'rejected' || s.value.status >= 500) unavailable.push(name);
        return null;
      };
      const body = {
        userId: ctx.actor.id,
        accountId: ctx.accountId ?? null,
        profile: ok('profile', profile),
        balances: ok('balances', balances),
        unreadNotifications:
          (ok('notifications', notifications) as { unreadCount?: number } | null)?.unreadCount ??
          null,
        unavailable,
      };
      if (body.profile) await audit(ctx, '/v1/me', 'customer_profile');
      return { body };
    },
  });

  // ---------------------------------------------------------------- repasse
  const forward =
    (route: ForwardRoute) =>
    async (q: Req, ctx: ExecutionContext): Promise<HandlerResult> => {
      const params = (q.params ?? {}) as Record<string, string>;
      let path = (route.upstream ?? route.path).replace(/:(\w+)/g, (_m, k: string) =>
        encodeURIComponent(params[k] ?? ''),
      );
      const isMe = route.path.startsWith('/v1/me');
      const raw = Object.fromEntries(
        Object.entries((q.query ?? {}) as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'string')
          .map(([k, v]) => [k, v as string]),
      );
      let query = isMe ? stripAccount(raw) : raw;
      if (route.mapQuery) {
        const m = route.mapQuery(query);
        query = m.query;
        if (m.upstream) path = m.upstream;
      }
      const extra: Record<string, string> = {};
      if (route.signature && !q.headers['x-trading-signature']) {
        const sig = cookiesOf(q)[COOKIES.signature(route.signature)];
        if (sig) extra['x-trading-signature'] = sig;
      }
      const result = await upstreams.call(route.service, {
        method: route.method,
        path,
        query,
        body: isMe ? stripAccount(q.body) : q.body,
        headers: q.headers,
        ctx,
        extra,
      });
      if (route.audit && result.status >= 200 && result.status < 300)
        await audit(ctx, route.path, route.audit);
      return {
        status: result.status,
        ...(result.body !== undefined ? { body: result.body } : {}),
        headers: result.headers,
      };
    };

  for (const route of ROUTES)
    service.route({
      method: route.method,
      path: route.path,
      auth: route.auth === 'public' ? 'public' : { principal: 'user' },
      // A idempotência é do dono (ele recebe a Idempotency-Key).
      idempotent: false,
      handler: forward(route),
    });

  return {
    service,
    tokens,
    async start() {
      await relay?.start();
    },
    async stop() {
      await relay?.stop();
      await closeStream?.();
    },
  };
}
