import { CalendarNotLoadedError } from '@broker/calendar';
import {
  HaltBody,
  JustificationBody,
  RejectBody,
  ResumeBody,
  tradingSessionServiceHttp,
} from '@broker/contracts/http/trading-session-service';
import { BusinessDate, DomainError, Instant } from '@broker/domain-kernel';
import {
  DEFAULT_LIMIT,
  HttpError,
  MAX_LIMIT,
  validationError,
  type ExecutionContext,
  type HandlerResult,
  type RouteDefinition,
  type Service,
} from '@broker/service-kit';
import type { TSchema } from 'typebox';
import { haltView, type Backoffice, type Operator } from '../application/backoffice.js';
import { SessionError } from '../application/context.js';
import type { ChangeRequestStatus } from '../application/ports.js';
import type { SessionQueries } from '../application/queries.js';

const r = tradingSessionServiceHttp.routes;

export interface HttpDeps {
  queries: SessionQueries;
  backoffice: Backoffice;
  /** RN-SBX-005: libera os comandos de teste (só no sandbox). */
  sandboxCommands: boolean;
}

function toHttp(err: unknown): never {
  if (err instanceof SessionError)
    throw new HttpError(err.status, err.code, err.message, {
      ...(err.status === 422 ? { title: err.message } : {}),
      ...(err.context ? { context: err.context } : {}),
    });
  if (err instanceof CalendarNotLoadedError || err instanceof DomainError)
    throw new HttpError(422, err.code, err.message, { title: err.message });
  throw err;
}

const operator = (ctx: ExecutionContext): Operator => ({ id: ctx.actor.id, roles: [...ctx.roles] });

const ANY = { principal: 'any' as const };
/** Backoffice §3: `BO_MARKET` opera o pregão. */
const MARKET = { roles: ['BO_MARKET', 'BO_ADMIN'] };
/** Consulta do backoffice. */
const READ = { roles: ['BO_MARKET', 'BO_ADMIN', 'BO_AUDITOR', 'BO_SUPPORT'] };
/** Quem decide é conferido na solicitação (RN-MC-BO). */
const DECIDE = { roles: ['BO_MARKET', 'BO_ADMIN'] };

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw validationError([
      { field: 'limit', code: 'INVALID_VALUE', message: 'limit precisa ser um inteiro ≥ 1.' },
    ]);
  return Math.min(n, MAX_LIMIT);
}

export function registerHttp(service: Service, d: HttpDeps): void {
  const run = async (fn: () => Promise<HandlerResult>) => {
    try {
      return await fn();
    } catch (err) {
      toHttp(err);
    }
  };
  const route = <
    SB extends TSchema | undefined = undefined,
    SQ extends TSchema | undefined = undefined,
    SP extends TSchema | undefined = undefined,
  >(
    def: RouteDefinition<SB, SQ, SP>,
  ) => service.route<SB, SQ, SP>({ idempotent: false, ...def });

  route({
    method: 'get',
    path: '/v1/market/session',
    auth: ANY,
    handler: () => run(async () => ({ body: await d.queries.session() })),
  });
  route({
    method: 'get',
    path: '/v1/market/session/:symbol',
    auth: ANY,
    validate: { params: r.instrumentSession.params },
    handler: (q) => run(async () => ({ body: await d.queries.instrument(q.params.symbol) })),
  });

  route({
    method: 'post',
    path: '/v1/bo/session/halt',
    auth: MARKET,
    validate: { body: HaltBody },
    handler: (q, ctx) =>
      run(async () => {
        const input = {
          reason: q.body.reason,
          cancelAllOnHalt: q.body.cancelAllOnHalt ?? false,
          resumeAt: q.body.resumeAt ? Instant.parse(q.body.resumeAt) : null,
        };
        if (q.body.instrumentId)
          return {
            body: await d.backoffice.haltInstrument(operator(ctx), {
              ...input,
              instrumentId: q.body.instrumentId,
            }),
          };
        return { status: 202, body: await d.backoffice.proposeMarketHalt(operator(ctx), input) };
      }),
  });
  route({
    method: 'post',
    path: '/v1/bo/session/resume',
    auth: MARKET,
    validate: { body: ResumeBody },
    handler: (q, ctx) =>
      run(async () => {
        const halt = (await d.queries.halts(true, MAX_LIMIT)).find((h) => h.id === q.body.haltId);
        if (halt?.scope !== 'MARKET')
          return { body: await d.backoffice.resumeInstrument(q.body.haltId) };
        return {
          status: 202,
          body: await d.backoffice.proposeMarketResume(operator(ctx), {
            haltId: q.body.haltId,
            justification: q.body.justification ?? '',
          }),
        };
      }),
  });
  route({
    method: 'post',
    path: '/v1/bo/session/circuit-breaker',
    auth: MARKET,
    validate: { body: JustificationBody },
    handler: (q, ctx) =>
      run(async () => ({
        status: 202,
        body: await d.backoffice.proposeCircuitBreaker(operator(ctx), q.body.justification),
      })),
  });
  if (d.sandboxCommands)
    route({
      method: 'post',
      path: '/v1/sandbox/session/circuit-breaker',
      auth: MARKET,
      handler: () => run(async () => ({ body: await d.backoffice.sandboxCircuitBreaker() })),
    });
  route({
    method: 'post',
    path: '/v1/bo/session/auctions/:id/conclude',
    auth: MARKET,
    validate: { params: r.concludeAuction.params },
    handler: (q) => run(async () => ({ body: await d.backoffice.concludeAuction(q.params.id) })),
  });

  route({
    method: 'get',
    path: '/v1/bo/session/halts',
    auth: READ,
    validate: { query: r.halts.query },
    handler: (q) =>
      run(async () => {
        const active = q.query.active === undefined ? undefined : q.query.active === 'true';
        const items = await d.queries.halts(active, parseLimit(q.query.limit));
        return { body: { items: items.map(haltView) } };
      }),
  });
  route({
    method: 'get',
    path: '/v1/bo/session/alerts',
    auth: READ,
    validate: { query: r.alerts.query },
    handler: (q) =>
      run(async () => {
        const items = await d.queries.alerts(parseLimit(q.query.limit));
        return {
          body: {
            items: items.map((a) => ({
              id: a.id,
              kind: a.kind,
              message: a.message,
              data: a.data,
              createdAt: a.createdAt.toString(),
            })),
          },
        };
      }),
  });
  route({
    method: 'get',
    path: '/v1/bo/session/closing-prices',
    auth: READ,
    validate: { query: r.closingPrices.query },
    handler: (q) =>
      run(async () => {
        const items = await d.queries.closingPrices(BusinessDate.parse(q.query.date));
        return {
          body: {
            items: items.map((c) => ({
              instrumentId: c.instrumentId,
              businessDate: c.businessDate.toString(),
              price: c.price.toFixed(),
              source: c.source,
              externalClose: c.externalClose?.toFixed() ?? null,
              divergenceAlert: c.divergenceAlert,
            })),
          },
        };
      }),
  });

  route({
    method: 'get',
    path: '/v1/bo/session/change-requests',
    auth: READ,
    validate: { query: r.changeRequests.query },
    handler: (q) =>
      run(async () => ({
        body: await d.backoffice.list(
          q.query.status as ChangeRequestStatus | undefined,
          parseLimit(q.query.limit),
        ),
      })),
  });
  route({
    method: 'post',
    path: '/v1/bo/session/change-requests/:id/approve',
    auth: DECIDE,
    validate: { params: r.approveRequest.params },
    handler: (q, ctx) =>
      run(async () => ({ body: await d.backoffice.approve(operator(ctx), q.params.id) })),
  });
  route({
    method: 'post',
    path: '/v1/bo/session/change-requests/:id/reject',
    auth: DECIDE,
    validate: { params: r.rejectRequest.params, body: RejectBody },
    handler: (q, ctx) =>
      run(async () => ({
        body: await d.backoffice.reject(operator(ctx), q.params.id, q.body.reason),
      })),
  });
  route({
    method: 'post',
    path: '/v1/bo/session/change-requests/:id/cancel',
    auth: DECIDE,
    validate: { params: r.cancelRequest.params },
    handler: (q, ctx) =>
      run(async () => ({ body: await d.backoffice.cancel(operator(ctx), q.params.id) })),
  });
}
