import type { Clock } from '@broker/clock';
import { ledgerServiceHttp } from '@broker/contracts/http/ledger-service';
import { BusinessDate, Instant, Money } from '@broker/domain-kernel';
import {
  DEFAULT_LIMIT,
  HttpError,
  MAX_LIMIT,
  parseEnumList,
  parsePeriod,
  validationError,
  type ExecutionContext,
  type HandlerResult,
  type RouteDefinition,
  type Service,
} from '@broker/service-kit';
import { assertWebhookSignature } from '@broker/webhooks';
import type { TSchema } from 'typebox';
import type { LedgerAccounts } from '../application/accounts.js';
import {
  LedgerError,
  type Caller,
  type LedgerDeps,
  type Operator,
} from '../application/context.js';
import type { Deposits } from '../application/deposits.js';
import type { Ledger } from '../application/posting.js';
import {
  STATEMENT_CATEGORIES,
  type Statement,
  type StatementCategory,
} from '../application/statement.js';
import type { Withdrawals } from '../application/withdrawals.js';
import { LedgerRuleError } from '../domain/journal.js';

const r = ledgerServiceHttp.routes;

export interface HttpDeps {
  ledger: Ledger;
  accounts: LedgerAccounts;
  deposits: Deposits;
  withdrawals: Withdrawals;
  statement: Statement;
  store: LedgerDeps['store'];
  clock: Clock;
  /** Segredo HMAC do webhook do Banco Simulado (RN-DEP-008, RN-SIM-003). */
  pixWebhookSecret: string;
}

function toHttp(err: unknown): never {
  if (err instanceof LedgerError)
    throw new HttpError(err.status, err.code, err.message, {
      ...(err.status === 422 ? { title: err.message } : {}),
      ...(err.context ? { context: err.context } : {}),
    });
  // LEDGER_UNBALANCED_JOURNAL e afins: erro interno que nunca deveria chegar ao cliente (§14).
  if (err instanceof LedgerRuleError)
    throw new HttpError(500, 'INTERNAL_ERROR', 'Ocorreu um erro inesperado no lançamento.');
  throw err;
}

const caller = (ctx: ExecutionContext): Caller => ({
  userId: ctx.actor.id,
  ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
});
const operator = (ctx: ExecutionContext): Operator => ({ id: ctx.actor.id, roles: [...ctx.roles] });

const USER = { principal: 'user' as const };
const FINANCE = { roles: ['BO_FINANCE', 'BO_ADMIN'] };

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

  // ---------------------------------------------------------------- saldos e extrato
  route({
    method: 'get',
    path: '/v1/me/balances',
    auth: USER,
    handler: (_q, ctx) =>
      run(async () => {
        const accountId = caller(ctx).accountId;
        const b = accountId
          ? await d.store.transaction((tx) => d.ledger.balances(tx, accountId))
          : null;
        if (!b) throw new LedgerError(404, 'NOT_FOUND', 'Conta inexistente no ledger.');
        return {
          body: {
            accountId: b.accountId,
            currency: b.currency,
            settled: b.settled.toString(),
            projected: {
              d0: b.projected.d0.toString(),
              d1: b.projected.d1.toString(),
              d2: b.projected.d2.toString(),
            },
            projectedTotal: b.projectedTotal.toString(),
            holds: b.holds.toString(),
            withdrawable: b.withdrawable.toString(),
            lastSequence: Number(b.lastSequence),
            asOf: b.asOf,
          },
        };
      }),
  });
  route({
    method: 'get',
    path: '/v1/me/statement',
    auth: USER,
    validate: { query: r.statement.query },
    handler: (q, ctx) =>
      run(async () => {
        const period = parsePeriod(q.query.from, q.query.to);
        const categories = parseEnumList(
          q.query.type,
          'type',
          Object.keys(STATEMENT_CATEGORIES) as StatementCategory[],
        );
        const statuses = parseEnumList(q.query.status, 'status', ['PENDING', 'SETTLED'] as const);
        return {
          body: await d.statement.list(caller(ctx), {
            ...(period.from ? { from: BusinessDate.parse(period.from) } : {}),
            ...(period.to ? { to: BusinessDate.parse(period.to) } : {}),
            ...(categories ? { categories } : {}),
            ...(statuses ? { statuses } : {}),
            limit: parseLimit(q.query.limit),
            ...(q.query.cursor ? { cursor: q.query.cursor } : {}),
          }),
        };
      }),
  });
  route({
    method: 'get',
    path: '/v1/me/statement/future',
    auth: USER,
    handler: (_q, ctx) => run(async () => ({ body: await d.statement.future(caller(ctx)) })),
  });

  // ---------------------------------------------------------------- depósitos
  route({
    method: 'post',
    path: '/v1/me/deposits',
    auth: USER,
    idempotent: true,
    validate: { body: r.createDeposit.body },
    handler: (q, ctx) =>
      run(async () => ({
        status: 201,
        body: await d.deposits.create(caller(ctx), q.body.amount),
      })),
  });
  route({
    method: 'get',
    path: '/v1/me/deposits',
    auth: USER,
    handler: (_q, ctx) =>
      run(async () => ({ body: { items: await d.deposits.list(caller(ctx)) } })),
  });
  route({
    method: 'get',
    path: '/v1/me/deposits/:id',
    auth: USER,
    validate: { params: r.getDeposit.params },
    handler: (q, ctx) =>
      run(async () => ({ body: await d.deposits.get(caller(ctx), q.params.id) })),
  });
  route({
    method: 'post',
    path: '/v1/me/deposits/:id/cancel',
    auth: USER,
    idempotent: true,
    validate: { params: r.cancelDeposit.params },
    handler: (q, ctx) =>
      run(async () => ({ body: await d.deposits.cancel(caller(ctx), q.params.id) })),
  });

  // Webhook do Banco Simulado: assinatura conferida antes de qualquer efeito (RN-DEP-008).
  route({
    method: 'post',
    path: '/webhooks/pix-simulator',
    auth: 'public',
    handler: (q) =>
      run(async () => {
        assertWebhookSignature(q, { secret: d.pixWebhookSecret, clock: d.clock });
        if (q.headers['x-webhook-event'] !== 'pix.recebido') return { status: 204 };
        const body = q.body as {
          pix?: {
            endToEndId: string;
            txid: string;
            valor: string;
            horario: string;
            pagador: { cpf?: string };
          }[];
        };
        for (const p of body.pix ?? []) {
          await d.deposits.onPixReceived({
            endToEndId: p.endToEndId,
            txid: p.txid,
            amount: Money.of(p.valor, 'BRL'),
            paidAt: Instant.ofEpochMillis(Date.parse(p.horario)),
            payerTaxId: p.pagador.cpf ?? null,
          });
        }
        return { status: 204 };
      }),
  });

  // ---------------------------------------------------------------- saques
  route({
    method: 'post',
    path: '/v1/me/withdrawals',
    auth: USER,
    idempotent: true,
    // RN-SAQ-003: assinatura eletrônica com escopo de saque.
    signature: 'WITHDRAWALS',
    validate: { body: r.requestWithdrawal.body },
    handler: (q, ctx) =>
      run(async () => ({ status: 202, body: await d.withdrawals.request(caller(ctx), q.body) })),
  });
  route({
    method: 'get',
    path: '/v1/me/withdrawals',
    auth: USER,
    handler: (_q, ctx) =>
      run(async () => ({ body: { items: await d.withdrawals.list(caller(ctx)) } })),
  });
  route({
    method: 'get',
    path: '/v1/me/withdrawals/:id',
    auth: USER,
    validate: { params: r.getWithdrawal.params },
    handler: (q, ctx) =>
      run(async () => ({ body: await d.withdrawals.get(caller(ctx), q.params.id) })),
  });
  route({
    method: 'post',
    path: '/v1/me/withdrawals/:id/cancel',
    auth: USER,
    idempotent: true,
    validate: { params: r.cancelWithdrawal.params },
    handler: (q, ctx) =>
      run(async () => ({ body: await d.withdrawals.cancel(caller(ctx), q.params.id) })),
  });

  // ---------------------------------------------------------------- backoffice
  route({
    method: 'get',
    path: '/v1/bo/withdrawals',
    auth: FINANCE,
    handler: () => run(async () => ({ body: { items: await d.withdrawals.reviewQueue() } })),
  });
  route({
    method: 'post',
    path: '/v1/bo/withdrawals/:id/approve',
    auth: FINANCE,
    validate: { params: r.approveWithdrawal.params },
    handler: (q, ctx) =>
      run(async () => ({ body: await d.withdrawals.approve(operator(ctx), q.params.id) })),
  });
  route({
    method: 'post',
    path: '/v1/bo/withdrawals/:id/reject',
    auth: FINANCE,
    validate: { params: r.rejectWithdrawal.params, body: r.rejectWithdrawal.body },
    handler: (q, ctx) =>
      run(async () => ({
        body: await d.withdrawals.reject(operator(ctx), q.params.id, q.body.reason),
      })),
  });
  route({
    method: 'get',
    path: '/v1/bo/reconciliations/pix/:date',
    auth: FINANCE,
    validate: { params: r.reconciliation.params },
    handler: (q) =>
      run(async () => {
        const rec = await d.store.transaction((tx) =>
          tx.reconciliation(BusinessDate.parse(q.params.date)),
        );
        if (!rec) throw new LedgerError(404, 'NOT_FOUND', 'Reconciliação não executada.');
        return {
          body: {
            businessDate: rec.businessDate.toString(),
            periodFrom: rec.periodFrom.toString(),
            periodTo: rec.periodTo.toString(),
            status: rec.status,
            checked: rec.checked,
            divergences: rec.divergences,
          },
        };
      }),
  });

  // ---------------------------------------------------------------- interna
  route({
    method: 'get',
    path: '/v1/internal/accounts/:id/closure-pendencies',
    auth: { principal: 'service', scopes: ['closure:read'] },
    validate: { params: r.closurePendencies.params },
    handler: (q) =>
      run(async () => ({
        body: {
          pendencies: (
            await d.store.transaction((tx) => d.accounts.closurePendencies(tx, q.params.id))
          ).map((p) => ({ code: p.code, message: p.message })),
        },
      })),
  });
}
