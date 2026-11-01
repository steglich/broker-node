import {
  KillSwitchBody,
  marketMakerServiceHttp,
  ParametersBody,
  RejectBody,
} from '@broker/contracts/http/market-maker-service';
import { DomainError } from '@broker/domain-kernel';
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
import type { Backoffice, Operator } from '../application/backoffice.js';
import { SmmError } from '../application/context.js';
import type { ChangeRequestStatus } from '../application/ports.js';
import type { SmmParams } from '../domain/params.js';

const r = marketMakerServiceHttp.routes;

export interface HttpDeps {
  backoffice: Backoffice;
}

function toHttp(err: unknown): never {
  if (err instanceof SmmError)
    throw new HttpError(err.status, err.code, err.message, {
      ...(err.status === 422 ? { title: err.message } : {}),
      ...(err.context ? { context: err.context } : {}),
    });
  if (err instanceof DomainError)
    throw new HttpError(422, err.code, err.message, { title: err.message });
  throw err;
}

const operator = (ctx: ExecutionContext): Operator => ({ id: ctx.actor.id, roles: [...ctx.roles] });

/** Backoffice §3: `BO_MARKET` opera o FMS. */
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
    method: 'post',
    path: '/v1/bo/smm/kill-switch',
    auth: MARKET,
    validate: { body: KillSwitchBody },
    handler: (q, ctx) =>
      run(async () => {
        const instrumentId = q.body.instrumentId ?? null;
        if (!q.body.enabled)
          return {
            body: await d.backoffice.disable(operator(ctx), {
              instrumentId,
              reason: q.body.justification,
            }),
          };
        return {
          status: 202,
          body: await d.backoffice.proposeEnable(operator(ctx), {
            instrumentId,
            justification: q.body.justification,
          }),
        };
      }),
  });

  // Antes de `/:instrumentId`, que também casaria com `change-requests`.
  route({
    method: 'get',
    path: '/v1/bo/smm/change-requests',
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
    path: '/v1/bo/smm/change-requests/:id/approve',
    auth: DECIDE,
    validate: { params: r.approveRequest.params },
    handler: (q, ctx) =>
      run(async () => ({ body: await d.backoffice.approve(operator(ctx), q.params.id) })),
  });
  route({
    method: 'post',
    path: '/v1/bo/smm/change-requests/:id/reject',
    auth: DECIDE,
    validate: { params: r.rejectRequest.params, body: RejectBody },
    handler: (q, ctx) =>
      run(async () => ({
        body: await d.backoffice.reject(operator(ctx), q.params.id, q.body.reason),
      })),
  });
  route({
    method: 'post',
    path: '/v1/bo/smm/change-requests/:id/cancel',
    auth: DECIDE,
    validate: { params: r.cancelRequest.params },
    handler: (q, ctx) =>
      run(async () => ({ body: await d.backoffice.cancel(operator(ctx), q.params.id) })),
  });

  route({
    method: 'get',
    path: '/v1/bo/smm/:instrumentId',
    auth: READ,
    validate: { params: r.state.params },
    handler: (q) => run(async () => ({ body: await d.backoffice.state(q.params.instrumentId) })),
  });
  route({
    method: 'put',
    path: '/v1/bo/smm/:instrumentId',
    auth: MARKET,
    validate: { params: r.parameters.params, body: ParametersBody },
    handler: (q, ctx) =>
      run(async () => ({
        status: 202,
        body: await d.backoffice.proposeParameters(operator(ctx), {
          instrumentId: q.params.instrumentId,
          params: q.body.params as Partial<SmmParams>,
          justification: q.body.justification,
        }),
      })),
  });
}
