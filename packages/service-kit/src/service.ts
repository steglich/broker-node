import type { Server } from 'node:http';
import type { Clock } from '@broker/clock';
import { uuidv7 } from '@broker/ids';
import { trace } from '@opentelemetry/api';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { TSchema, Static } from 'typebox';
import { authorize, type AccessPolicy, type Authenticator } from './auth.js';
import type { BaseConfig } from './config.js';
import { ANONYMOUS, runWithContext, type Channel, type ExecutionContext } from './context.js';
import { HttpError, toProblem, validationError } from './errors.js';
import { featureUnavailable, type FeatureFlags } from './flags.js';
import { requestHash, type IdempotencyStore } from './idempotency.js';
import type { Logger } from './logger.js';
import { recordHttpRequest } from './metrics.js';
import { validateInput } from './validation.js';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface HandlerResult {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RouteRequest<B, Q, P> {
  body: B;
  query: Q;
  params: P;
  headers: Request['headers'];
  /** Requisição Express original, para casos especiais. */
  raw: Request;
}

type Infer<S> = S extends TSchema ? Static<S> : unknown;

export interface RouteDefinition<SB, SQ, SP> {
  method: Method;
  path: string;
  /** Obrigatório (RN-AUTHZ-001): `'public'` ou os escopos/papéis exigidos. */
  auth: AccessPolicy;
  validate?: { body?: SB; query?: SQ; params?: SP };
  /** Exige `Idempotency-Key` (padrão: true para POST, RN-PAD §4). */
  idempotent?: boolean;
  /** Feature flag que precisa estar ligada (RN-PAD-072). */
  flag?: string;
  /** Resposta com dados de conta: `Cache-Control: no-store` (padrão true). */
  accountData?: boolean;
  handler: (
    req: RouteRequest<Infer<SB>, Infer<SQ>, Infer<SP>>,
    ctx: ExecutionContext,
  ) => Promise<HandlerResult>;
}

export interface ServiceOptions {
  config: BaseConfig;
  clock: Clock;
  logger: Logger;
  /** Dependências críticas para o readiness (ex.: banco, broker). Cada uma lança se indisponível. */
  readiness?: Record<string, () => Promise<unknown>>;
  authenticator?: Authenticator;
  idempotency?: IdempotencyStore;
  flags?: FeatureFlags;
  /** Limite do corpo (RN-API-042: 64 KB). */
  bodyLimit?: string;
}

const CORRELATION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CHANNELS = new Set<Channel>(['WEB', 'MOBILE', 'DESKTOP', 'BACKOFFICE']);

/**
 * Esqueleto de todo microsserviço (D2, D3): Express 5 com contexto de execução, correlação,
 * Problem Details, health/info, métricas RED e encerramento gracioso. As rotas são declaradas com
 * `route()`, que aplica autenticação, autorização, flag, validação e idempotência nessa ordem.
 */
export class Service {
  readonly app: Express;
  private server: Server | undefined;
  private ready = true;
  private shuttingDown = false;
  private readonly startedAt: string;
  private readonly shutdownHooks: Array<{ name: string; fn: () => Promise<unknown> }> = [];
  private readonly routes = express.Router();

  constructor(private readonly options: ServiceOptions) {
    this.startedAt = new Date().toISOString();
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', true);
    app.use((req, res, next) => this.withContext(req, res, next));
    app.use(express.json({ limit: options.bodyLimit ?? '64kb' }));
    this.mountHealth(app);
    app.use(this.routes);
    app.use((req, _res, next) =>
      next(new HttpError(404, 'NOT_FOUND', `Rota não encontrada: ${req.method} ${req.path}`)),
    );
    app.use((err: unknown, req: Request, res: Response, next: NextFunction) =>
      this.sendError(err, req, res, next),
    );
    this.app = app;
  }

  get logger(): Logger {
    return this.options.logger;
  }

  /** Readiness falso enquanto o estado em memória é reconstruído (RN-OBS §5). */
  setReady(ready: boolean): void {
    this.ready = ready;
  }

  /** Registra o que fechar no encerramento (consumidores, relay, pools). Roda na ordem inversa. */
  onShutdown(name: string, fn: () => Promise<unknown>): void {
    this.shutdownHooks.push({ name, fn });
  }

  route<
    SB extends TSchema | undefined = undefined,
    SQ extends TSchema | undefined = undefined,
    SP extends TSchema | undefined = undefined,
  >(def: RouteDefinition<SB, SQ, SP>): void {
    if (def.auth === undefined)
      throw new Error(
        `rota ${def.method.toUpperCase()} ${def.path} sem política de acesso (RN-AUTHZ-001)`,
      );
    const idempotent = def.idempotent ?? def.method === 'post';
    this.routes[def.method](def.path, async (req: Request, res: Response) => {
      const ctx = res.locals['ctx'] as ExecutionContext;
      await this.authenticate(req, def.auth, ctx);
      if (
        def.flag &&
        this.options.flags &&
        !(await this.options.flags.isEnabled(def.flag, ctx.accountId))
      ) {
        throw featureUnavailable(def.flag);
      }
      const input: RouteRequest<unknown, unknown, unknown> = {
        body: def.validate?.body ? validateInput(def.validate.body, req.body, 'body') : req.body,
        query: def.validate?.query
          ? validateInput(def.validate.query, req.query, 'query')
          : req.query,
        params: def.validate?.params
          ? validateInput(def.validate.params, req.params, 'params')
          : req.params,
        headers: req.headers,
        raw: req,
      };
      if (def.accountData ?? true) res.setHeader('Cache-Control', 'no-store');

      const run = () => def.handler(input as never, ctx);
      const result = idempotent
        ? await this.idempotently(req, ctx, input.body, run, res)
        : await run();
      this.sendResult(res, result);
    });
  }

  async start(): Promise<Server> {
    const { PORT, SERVICE_NAME } = this.options.config;
    await new Promise<void>((resolve) => {
      this.server = this.app.listen(PORT, () => resolve());
    });
    for (const signal of ['SIGTERM', 'SIGINT'] as const)
      process.once(signal, () => void this.shutdown(signal));
    this.logger.info(
      { event: 'service.started', port: PORT },
      `${SERVICE_NAME} ouvindo na porta ${PORT}`,
    );
    return this.server!;
  }

  /**
   * Encerramento gracioso: readiness vira falso, o servidor para de aceitar conexões, as
   * requisições em andamento terminam (até `SHUTDOWN_TIMEOUT_MS`) e os ganchos fecham o resto.
   */
  async shutdown(reason = 'stop', exit = true): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.ready = false;
    this.logger.info({ event: 'service.stopping', reason }, 'encerrando');
    const server = this.server;
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const timeout = new Promise<'timeout'>((r) =>
        setTimeout(() => r('timeout'), this.options.config.SHUTDOWN_TIMEOUT_MS).unref(),
      );
      if ((await Promise.race([closed, timeout])) === 'timeout') {
        this.logger.warn(
          { event: 'service.shutdown_timeout' },
          'requisições em andamento interrompidas no limite',
        );
        server.closeAllConnections();
      }
    }
    for (const hook of [...this.shutdownHooks].reverse()) {
      await hook
        .fn()
        .catch((err: unknown) =>
          this.logger.error(
            { event: 'service.shutdown_hook_failed', hook: hook.name, err },
            'falha ao fechar',
          ),
        );
    }
    this.logger.info({ event: 'service.stopped' }, 'encerrado');
    this.logger.flush();
    if (exit) process.exit(0);
  }

  // ------------------------------------------------------------------ internos

  private withContext(req: Request, res: Response, next: NextFunction): void {
    const header = req.header('x-correlation-id');
    const correlationId = header && CORRELATION_PATTERN.test(header) ? header : uuidv7();
    const channelHeader = req.header('x-client-channel')?.toUpperCase() as Channel | undefined;
    const ctx: ExecutionContext = {
      actor: ANONYMOUS,
      correlationId,
      channel: channelHeader && CHANNELS.has(channelHeader) ? channelHeader : 'SERVICE',
      ...(req.ip ? { ip: req.ip } : {}),
      ...(req.header('user-agent') ? { userAgent: req.header('user-agent')! } : {}),
      ...(req.header('idempotency-key') ? { idempotencyKey: req.header('idempotency-key')! } : {}),
      requestedAt: this.options.clock.now(),
      scopes: new Set(),
      roles: new Set(),
    };
    res.locals['ctx'] = ctx;
    res.setHeader('X-Correlation-Id', correlationId);
    const traceId = trace.getActiveSpan()?.spanContext().traceId;
    if (traceId && !/^0+$/.test(traceId)) res.setHeader('X-Trace-Id', traceId);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const started = performance.now();
    res.on('finish', () => {
      const route =
        (req.route as { path?: string } | undefined)?.path ??
        (res.statusCode === 404 ? 'unmatched' : req.path);
      const durationMs = performance.now() - started;
      recordHttpRequest(req.method, route, res.statusCode, durationMs);
      runWithContext(ctx, () =>
        this.logger.info(
          {
            event: 'http.request',
            method: req.method,
            route,
            status: res.statusCode,
            duration_ms: Math.round(durationMs),
          },
          `${req.method} ${route} ${res.statusCode}`,
        ),
      );
    });
    runWithContext(ctx, next);
  }

  private async authenticate(
    req: Request,
    policy: AccessPolicy,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (policy === 'public') return;
    if (!this.options.authenticator)
      throw new Error('rota protegida sem Authenticator configurado');
    const principal = await this.options.authenticator.authenticate(req.header('authorization'));
    authorize(principal, policy);
    ctx.actor = principal.actor;
    if (principal.accountId) ctx.accountId = principal.accountId;
    ctx.scopes = principal.scopes;
    ctx.roles = principal.roles;
    if (principal.actor.type === 'SERVICE') ctx.channel = 'SERVICE';
  }

  private async idempotently(
    req: Request,
    ctx: ExecutionContext,
    body: unknown,
    run: () => Promise<HandlerResult>,
    res: Response,
  ): Promise<HandlerResult> {
    const key = ctx.idempotencyKey;
    if (!key) {
      throw validationError(
        [
          {
            field: 'Idempotency-Key',
            code: 'REQUIRED',
            message: 'Envie uma Idempotency-Key única por operação.',
          },
        ],
        'Idempotency-Key obrigatória neste comando.',
      );
    }
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw validationError([
        {
          field: 'Idempotency-Key',
          code: 'INVALID_FORMAT',
          message: 'Use de 8 a 128 caracteres (ex.: um UUID).',
        },
      ]);
    }
    const store = this.options.idempotency;
    if (!store) throw new Error('rota idempotente sem IdempotencyStore configurado');
    const hash = requestHash(req.method, req.originalUrl.split('?')[0]!, body);
    const decision = await store.begin(ctx.actor.id, key, hash);
    if (decision.kind === 'REPLAY') {
      res.setHeader('Idempotent-Replayed', 'true');
      return { status: decision.response.status, body: decision.response.body };
    }
    try {
      const result = await run();
      await store.complete(ctx.actor.id, key, hash, {
        status: result.status ?? 200,
        body: result.body ?? null,
      });
      return result;
    } catch (err) {
      // Erro de negócio (4xx) é uma resposta final e também vale para as repetições.
      if (err instanceof HttpError && err.status < 500) {
        const { problem } = toProblem(err, req.originalUrl, ctx.correlationId);
        await store.complete(ctx.actor.id, key, hash, { status: err.status, body: problem });
      } else {
        await store.abandon(ctx.actor.id, key).catch(() => undefined);
      }
      throw err;
    }
  }

  private sendResult(res: Response, result: HandlerResult): void {
    for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v);
    const status = result.status ?? (result.body === undefined ? 204 : 200);
    if (result.body === undefined || status === 204) {
      res.status(status).end();
      return;
    }
    const isProblem =
      typeof result.body === 'object' &&
      result.body !== null &&
      'type' in result.body &&
      'status' in result.body &&
      status >= 400;
    res
      .status(status)
      .type(isProblem ? 'application/problem+json' : 'application/json')
      .send(JSON.stringify(result.body));
  }

  private sendError(err: unknown, req: Request, res: Response, next: NextFunction): void {
    if (res.headersSent) return next(err);
    const ctx = res.locals['ctx'] as ExecutionContext | undefined;
    const correlationId = ctx?.correlationId ?? uuidv7();
    let error = err;
    // Erros do parser de JSON do Express.
    const type = (err as { type?: string }).type;
    if (type === 'entity.parse.failed')
      error = new HttpError(400, 'MALFORMED_JSON', 'O corpo não é um JSON válido.');
    if (type === 'entity.too.large')
      error = new HttpError(413, 'PAYLOAD_TOO_LARGE', 'O corpo passa do limite de 64 KB.');

    const { problem, headers } = toProblem(error, req.originalUrl, correlationId);
    if (problem.status >= 500) {
      const log = () =>
        this.logger.error(
          { event: 'http.unhandled_error', err: error, code: problem.code },
          'erro ao processar a requisição',
        );
      if (ctx) runWithContext(ctx, log);
      else log();
    }
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.status(problem.status).type('application/problem+json').send(JSON.stringify(problem));
  }

  private mountHealth(app: Express): void {
    // Liveness: o processo responde. Não olha dependências (RN-OBS §5).
    app.get('/health/live', (_req, res) => {
      res.json({ status: 'UP' });
    });
    // Readiness: dependências críticas acessíveis e estado carregado.
    app.get('/health/ready', async (_req, res) => {
      const checks: Record<string, 'UP' | 'DOWN'> = {};
      await Promise.all(
        Object.entries(this.options.readiness ?? {}).map(async ([name, check]) => {
          const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 2000).unref(),
          );
          checks[name] = await Promise.race([check(), timeout]).then(
            () => 'UP' as const,
            () => 'DOWN' as const,
          );
        }),
      );
      const ok = this.ready && !this.shuttingDown && Object.values(checks).every((c) => c === 'UP');
      res
        .status(ok ? 200 : 503)
        .json({ status: ok ? 'UP' : 'DOWN', state: this.ready ? 'LOADED' : 'LOADING', checks });
    });
    // Info: versão, commit, ambiente e início (RN-CICD-020).
    app.get('/info', (_req, res) => {
      const c = this.options.config;
      res.json({
        service: c.SERVICE_NAME,
        version: c.SERVICE_VERSION,
        commit: c.GIT_COMMIT,
        environment: c.ENVIRONMENT,
        startedAt: this.startedAt,
      });
    });
  }
}

export const createService = (options: ServiceOptions): Service => new Service(options);
