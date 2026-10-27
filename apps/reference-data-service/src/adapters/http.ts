import { CalendarNotLoadedError } from '@broker/calendar';
import { referenceDataServiceHttp } from '@broker/contracts/http/reference-data-service';
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
import type { CalendarService } from '../application/calendar.js';
import type { ChangeRequests } from '../application/change-requests.js';
import { ReferenceError, type Operator } from '../application/context.js';
import type { Instruments } from '../application/instruments.js';
import type { Renames } from '../application/renames.js';
import type { TradingRules } from '../application/trading-rules.js';
import type { Universe } from '../application/universe.js';
import type { ChangeRequestStatus } from '../domain/change-request.js';
import { ReferenceRuleError } from '../domain/errors.js';
import type { InstrumentStatus } from '../domain/instrument.js';

const r = referenceDataServiceHttp.routes;

export interface HttpDeps {
  instruments: Instruments;
  universe: Universe;
  renames: Renames;
  rules: TradingRules;
  calendar: CalendarService;
  requests: ChangeRequests;
}

function toHttp(err: unknown): never {
  if (err instanceof ReferenceError)
    throw new HttpError(err.status, err.code, err.message, {
      ...(err.status === 422 ? { title: err.message } : {}),
      ...(err.context ? { context: err.context } : {}),
    });
  if (err instanceof ReferenceRuleError)
    throw new HttpError(422, err.code, err.message, {
      title: err.message,
      ...(err.context ? { context: err.context } : {}),
    });
  if (err instanceof CalendarNotLoadedError)
    throw new HttpError(422, err.code, err.message, { title: err.message });
  if (err instanceof DomainError)
    throw new HttpError(422, err.code, err.message, { title: err.message });
  throw err;
}

const operator = (ctx: ExecutionContext): Operator => ({ id: ctx.actor.id, roles: [...ctx.roles] });

/** Consulta: clientes, operadores e serviços (cópia inicial dos consumidores). */
const ANY = { principal: 'any' as const };
/** Cadastro e propostas do mercado (Backoffice §3). */
const MARKET = { roles: ['BO_MARKET', 'BO_ADMIN'] };
/** Decisões: o papel exato do checker é conferido por tipo de solicitação. */
const BACKOFFICE = { roles: ['BO_MARKET', 'BO_ADMIN'] };

function parseLimit(value: unknown, fallback = DEFAULT_LIMIT): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw validationError([
      { field: 'limit', code: 'INVALID_VALUE', message: 'limit precisa ser um inteiro ≥ 1.' },
    ]);
  return Math.min(n, MAX_LIMIT);
}

function oneOf<T extends string>(
  value: string | undefined,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T))
    throw validationError([
      { field, code: 'INVALID_VALUE', message: `${field} inválido: ${value}.` },
    ]);
  return value as T;
}

const date = (v: string) => BusinessDate.parse(v);

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

  // ---------------------------------------------------------------- instrumentos (consulta)
  route({
    method: 'get',
    path: '/v1/instruments/search',
    auth: ANY,
    validate: { query: r.searchInstruments.query },
    handler: (q) =>
      run(async () => ({
        body: { items: await d.instruments.search(q.query.q, parseLimit(q.query.limit, 20)) },
      })),
  });
  route({
    method: 'get',
    path: '/v1/instruments/by-symbol/:symbol',
    auth: ANY,
    validate: { params: r.resolveSymbol.params },
    handler: (q) => run(async () => ({ body: await d.instruments.resolve(q.params.symbol) })),
  });
  route({
    method: 'get',
    path: '/v1/instruments/universe',
    auth: ANY,
    handler: () => run(async () => ({ body: await d.universe.snapshot() })),
  });
  route({
    method: 'get',
    path: '/v1/instruments',
    auth: ANY,
    validate: { query: r.listInstruments.query },
    handler: (q) =>
      run(async () => {
        const status = oneOf<InstrumentStatus>(q.query.status, 'status', [
          'PENDING',
          'ACTIVE',
          'SUSPENDED',
          'DELISTED',
        ]);
        return {
          body: await d.instruments.list({
            ...(q.query.tradable ? { tradable: q.query.tradable === 'true' } : {}),
            ...(status ? { status } : {}),
            limit: parseLimit(q.query.limit),
            ...(q.query.cursor ? { after: q.query.cursor } : {}),
          }),
        };
      }),
  });
  route({
    method: 'get',
    path: '/v1/instruments/:id',
    auth: ANY,
    validate: { params: r.getInstrument.params },
    handler: (q) => run(async () => ({ body: await d.instruments.get(q.params.id) })),
  });
  route({
    method: 'get',
    path: '/v1/instruments/:id/symbol-history',
    auth: ANY,
    validate: { params: r.symbolHistory.params },
    handler: (q) => run(async () => ({ body: { items: await d.renames.history(q.params.id) } })),
  });
  route({
    method: 'get',
    path: '/v1/trading-rules/effective',
    auth: ANY,
    validate: { query: r.effectiveRules.query },
    handler: (q) =>
      run(async () => ({
        body: await d.rules.effective(
          q.query.instrumentId ?? null,
          q.query.at ? Instant.parse(q.query.at) : undefined,
        ),
      })),
  });

  // ---------------------------------------------------------------- calendário (RN-CAL-002)
  route({
    method: 'get',
    path: '/v1/calendar',
    auth: ANY,
    handler: () => run(async () => ({ body: await d.calendar.read((_c, data) => data) })),
  });
  route({
    method: 'get',
    path: '/v1/calendar/days/:date',
    auth: ANY,
    validate: { params: r.calendarDay.params },
    handler: (q) =>
      run(async () => ({
        body: await d.calendar.read((cal) => {
          const day = date(q.params.date);
          const schedule = cal.sessionSchedule(day);
          return {
            date: day.toString(),
            dayType: cal.dayType(day),
            businessDay: cal.isBusinessDay(day),
            nextBusinessDay: cal.nextBusinessDay(day).toString(),
            previousBusinessDay: cal.previousBusinessDay(day).toString(),
            sessionSchedule: schedule && {
              dayType: schedule.dayType,
              phases: schedule.phases.map((p) => ({
                phase: p.phase,
                startsAt: p.startsAt.toString(),
                endsAt: p.endsAt.toString(),
              })),
            },
          };
        }),
      })),
  });
  route({
    method: 'get',
    path: '/v1/calendar/days/:date/next',
    auth: ANY,
    validate: { params: r.nextBusinessDay.params, query: r.nextBusinessDay.query },
    handler: (q) =>
      run(async () => {
        const n = Number(q.query.n ?? '1');
        if (n === 0)
          throw validationError([
            { field: 'n', code: 'INVALID_VALUE', message: 'n não pode ser 0.' },
          ]);
        const result = await d.calendar.read((cal) =>
          n > 0
            ? cal.nextBusinessDay(date(q.params.date), n)
            : cal.previousBusinessDay(date(q.params.date), -n),
        );
        return { body: { date: q.params.date, n, result: result.toString() } };
      }),
  });
  route({
    method: 'get',
    path: '/v1/calendar/business-days-between',
    auth: ANY,
    validate: { query: r.businessDaysBetween.query },
    handler: (q) =>
      run(async () => ({
        body: {
          from: q.query.from,
          to: q.query.to,
          businessDays: await d.calendar.read((cal) =>
            cal.businessDaysBetween(date(q.query.from), date(q.query.to)),
          ),
        },
      })),
  });

  // ---------------------------------------------------------------- backoffice: cadastro
  route({
    method: 'post',
    path: '/v1/bo/instruments',
    auth: MARKET,
    idempotent: true,
    validate: { body: r.createInstrument.body },
    handler: (q, ctx) =>
      run(async () => ({ status: 201, body: await d.instruments.create(operator(ctx), q.body) })),
  });
  route({
    method: 'patch',
    path: '/v1/bo/instruments/:id',
    auth: MARKET,
    validate: { params: r.updateInstrument.params, body: r.updateInstrument.body },
    handler: (q, ctx) =>
      run(async () => ({ body: await d.instruments.update(operator(ctx), q.params.id, q.body) })),
  });
  route({
    method: 'post',
    path: '/v1/bo/instruments/:id/status',
    auth: MARKET,
    validate: { params: r.setStatus.params, body: r.setStatus.body },
    handler: (q, ctx) =>
      run(async () => ({
        body: await d.instruments.setStatus(
          operator(ctx),
          q.params.id,
          q.body.status,
          q.body.reason,
        ),
      })),
  });
  route({
    method: 'post',
    path: '/v1/bo/instruments/:id/rename',
    auth: MARKET,
    validate: { params: r.renameInstrument.params, body: r.renameInstrument.body },
    handler: (q, ctx) =>
      run(async () => ({ body: await d.renames.rename(operator(ctx), q.params.id, q.body) })),
  });
  route({
    method: 'get',
    path: '/v1/bo/instrument-type-defaults',
    auth: MARKET,
    handler: () => run(async () => ({ body: { items: await d.instruments.typeDefaults() } })),
  });
  route({
    method: 'put',
    path: '/v1/bo/instrument-type-defaults/:assetType',
    auth: MARKET,
    validate: { params: r.updateTypeDefaults.params, body: r.updateTypeDefaults.body },
    handler: (q) =>
      run(async () => ({
        body: await d.instruments.updateTypeDefaults(q.params.assetType, q.body),
      })),
  });

  // ---------------------------------------------------------------- backoffice: propostas
  route({
    method: 'post',
    path: '/v1/bo/universe/requests',
    auth: MARKET,
    idempotent: true,
    validate: { body: r.requestUniverseChange.body },
    handler: (q, ctx) =>
      run(async () => ({ status: 201, body: await d.universe.request(operator(ctx), q.body) })),
  });
  route({
    method: 'post',
    path: '/v1/bo/trading-rules/requests',
    auth: MARKET,
    idempotent: true,
    validate: { body: r.requestTradingRules.body },
    handler: (q, ctx) =>
      run(async () => ({ status: 201, body: await d.rules.request(operator(ctx), q.body) })),
  });
  route({
    method: 'get',
    path: '/v1/bo/trading-rules',
    auth: MARKET,
    validate: { query: r.tradingRuleVersions.query },
    handler: (q) =>
      run(async () => ({ body: { items: await d.rules.versions(q.query.instrumentId ?? null) } })),
  });
  route({
    method: 'post',
    path: '/v1/bo/calendar/requests',
    auth: MARKET,
    idempotent: true,
    validate: { body: r.requestCalendarChange.body },
    handler: (q, ctx) =>
      run(async () => {
        const { justification, ...change } = q.body;
        return {
          status: 201,
          body: await d.calendar.requestChange(operator(ctx), change, justification),
        };
      }),
  });
  route({
    method: 'post',
    path: '/v1/bo/session-schedules/requests',
    auth: MARKET,
    idempotent: true,
    validate: { body: r.requestSessionSchedule.body },
    handler: (q, ctx) =>
      run(async () => {
        const { justification, ...schedule } = q.body;
        return {
          status: 201,
          body: await d.calendar.requestSchedule(operator(ctx), schedule, justification),
        };
      }),
  });
  route({
    method: 'get',
    path: '/v1/bo/session-schedules',
    auth: MARKET,
    handler: () => run(async () => ({ body: { items: await d.calendar.schedules() } })),
  });

  // ---------------------------------------------------------------- backoffice: decisões e tarefas
  route({
    method: 'get',
    path: '/v1/bo/change-requests',
    auth: BACKOFFICE,
    validate: { query: r.listChangeRequests.query },
    handler: (q) =>
      run(async () => {
        const status = oneOf<ChangeRequestStatus>(q.query.status, 'status', [
          'PENDING',
          'APPROVED',
          'REJECTED',
          'EXPIRED',
          'CANCELED',
          'STALE',
        ]);
        return { body: { items: await d.requests.list(status) } };
      }),
  });
  route({
    method: 'post',
    path: '/v1/bo/change-requests/:id/approve',
    auth: BACKOFFICE,
    validate: { params: r.approveChangeRequest.params },
    handler: (q, ctx) =>
      run(async () => ({ body: await d.requests.approve(operator(ctx), q.params.id) })),
  });
  route({
    method: 'post',
    path: '/v1/bo/change-requests/:id/reject',
    auth: BACKOFFICE,
    validate: { params: r.rejectChangeRequest.params, body: r.rejectChangeRequest.body },
    handler: (q, ctx) =>
      run(async () => ({
        body: await d.requests.reject(operator(ctx), q.params.id, q.body.reason),
      })),
  });
  route({
    method: 'post',
    path: '/v1/bo/change-requests/:id/cancel',
    auth: BACKOFFICE,
    validate: { params: r.cancelChangeRequest.params },
    handler: (q, ctx) =>
      run(async () => ({ body: await d.requests.cancel(operator(ctx), q.params.id) })),
  });
  route({
    method: 'get',
    path: '/v1/bo/tasks',
    auth: MARKET,
    validate: { query: r.listTasks.query },
    handler: (q) =>
      run(async () => ({
        body: {
          items: await d.renames.tasks(
            oneOf(q.query.status, 'status', ['OPEN', 'DONE', 'DISMISSED'] as const),
          ),
        },
      })),
  });
  route({
    method: 'post',
    path: '/v1/bo/tasks/:id/confirm',
    auth: MARKET,
    validate: { params: r.confirmTask.params },
    handler: (q, ctx) =>
      run(async () => ({ body: await d.renames.confirm(operator(ctx), q.params.id) })),
  });
  route({
    method: 'post',
    path: '/v1/bo/tasks/:id/resolve',
    auth: MARKET,
    validate: { params: r.resolveTask.params, body: r.resolveTask.body },
    handler: (q, ctx) =>
      run(async () => ({
        body: await d.renames.resolve(operator(ctx), q.params.id, q.body.status),
      })),
  });
}
