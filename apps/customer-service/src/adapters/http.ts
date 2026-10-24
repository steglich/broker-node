import type { Clock } from '@broker/clock';
import { customerServiceHttp } from '@broker/contracts/http/customer-service';
import {
  HttpError,
  type ExecutionContext,
  type HandlerResult,
  type RouteDefinition,
  type Service,
} from '@broker/service-kit';
import { assertWebhookSignature } from '@broker/webhooks';
import type { TSchema } from 'typebox';
import type { Accounts } from '../application/accounts.js';
import { CustomerError, type Caller, type Operator } from '../application/context.js';
import type {
  Address,
  FinancialProfile,
  Onboarding,
  PersonalData,
} from '../application/onboarding.js';
import type { SuitabilityAndTerms } from '../application/suitability-terms.js';
import type { Operation } from '../domain/account.js';
import type { DocumentType } from '../domain/documents.js';

const r = customerServiceHttp.routes;

export interface HttpDeps {
  onboarding: Onboarding;
  suitability: SuitabilityAndTerms;
  accounts: Accounts;
  clock: Clock;
  /** Segredo HMAC do webhook do KYC simulado (RN-SIM-003). */
  kycWebhookSecret: string;
}

function toHttp(err: unknown): never {
  if (!(err instanceof CustomerError)) throw err;
  throw new HttpError(err.status, err.code, err.message, {
    ...(err.status === 422 ? { title: err.message } : {}),
    ...(err.field ? { errors: [{ field: err.field, code: err.code, message: err.message }] } : {}),
    ...(err.context ? { context: err.context } : {}),
  });
}

const caller = (ctx: ExecutionContext): Caller => ({
  userId: ctx.actor.id,
  ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
  ...(ctx.ip ? { ip: ctx.ip } : {}),
  ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
  channel: ctx.channel,
});
const operator = (ctx: ExecutionContext): Operator => ({ id: ctx.actor.id, roles: [...ctx.roles] });

const USER = { principal: 'user' as const };
const ONBOARDING_REVIEW = { roles: ['BO_ONBOARDING', 'BO_ADMIN'] };
const ACCOUNT_BLOCK = { roles: ['BO_RISK', 'BO_FINANCE', 'BO_ADMIN'] };
const ADMIN = { roles: ['BO_ADMIN'] };

export function registerHttp(service: Service, d: HttpDeps): void {
  const run = async (fn: () => Promise<HandlerResult>) => {
    try {
      return await fn();
    } catch (err) {
      toHttp(err);
    }
  };
  // As etapas do onboarding são idempotentes por natureza (PUT de rascunho); os comandos com
  // efeito externo usam Idempotency-Key (Contratos §2).
  const route = <
    SB extends TSchema | undefined = undefined,
    SQ extends TSchema | undefined = undefined,
    SP extends TSchema | undefined = undefined,
  >(
    def: RouteDefinition<SB, SQ, SP>,
  ) => service.route<SB, SQ, SP>({ idempotent: false, ...def });

  // ---------------------------------------------------------------- onboarding
  route({
    method: 'get',
    path: '/v1/me/onboarding',
    auth: USER,
    handler: (_q, ctx) => run(async () => ({ body: await d.onboarding.view(ctx.actor.id) })),
  });
  route({
    method: 'put',
    path: '/v1/me/onboarding/contact',
    auth: USER,
    validate: { body: r.contact.body },
    handler: (q, ctx) =>
      run(async () => (await d.onboarding.saveContact(ctx.actor.id, q.body), { status: 204 })),
  });
  route({
    method: 'post',
    path: '/v1/me/onboarding/contact/verify',
    auth: USER,
    validate: { body: r.verifyContact.body },
    handler: (q, ctx) =>
      run(async () => (await d.onboarding.verifyContact(ctx.actor.id, q.body), { status: 204 })),
  });
  route({
    method: 'put',
    path: '/v1/me/onboarding/personal-data',
    auth: USER,
    validate: { body: r.personalData.body },
    handler: (q, ctx) =>
      run(
        async () => (
          await d.onboarding.savePersonal(ctx.actor.id, q.body as PersonalData),
          { status: 204 }
        ),
      ),
  });
  route({
    method: 'put',
    path: '/v1/me/onboarding/address',
    auth: USER,
    validate: { body: r.address.body },
    handler: (q, ctx) =>
      run(
        async () => (
          await d.onboarding.saveAddress(ctx.actor.id, q.body as Address),
          { status: 204 }
        ),
      ),
  });
  route({
    method: 'put',
    path: '/v1/me/onboarding/financial-profile',
    auth: USER,
    validate: { body: r.financialProfile.body },
    handler: (q, ctx) =>
      run(
        async () => (
          await d.onboarding.saveFinancial(ctx.actor.id, q.body as FinancialProfile),
          { status: 204 }
        ),
      ),
  });
  route({
    method: 'post',
    path: '/v1/me/onboarding/documents/upload-url',
    auth: USER,
    idempotent: true,
    validate: { body: r.uploadUrl.body },
    handler: (q, ctx) =>
      run(async () => ({
        status: 201,
        body: await d.onboarding.requestUpload(ctx.actor.id, {
          ...q.body,
          type: q.body.type as DocumentType,
        }),
      })),
  });
  route({
    method: 'post',
    path: '/v1/me/onboarding/documents',
    auth: USER,
    validate: { body: r.registerDocument.body },
    handler: (q, ctx) =>
      run(async () => ({
        body: await d.onboarding.confirmDocument(ctx.actor.id, q.body.documentId),
      })),
  });
  route({
    method: 'post',
    path: '/v1/me/onboarding/submit',
    auth: USER,
    idempotent: true,
    handler: (_q, ctx) =>
      run(async () => ({ status: 202, body: await d.onboarding.submit(ctx.actor.id) })),
  });
  // Webhook do KYC: assinatura conferida antes de qualquer efeito (RN-SIM-003).
  route({
    method: 'post',
    path: '/webhooks/kyc-simulator',
    auth: 'public',
    handler: async (q) => {
      assertWebhookSignature(q, { secret: d.kycWebhookSecret, clock: d.clock });
      const event = q.headers['x-webhook-event'];
      const body = q.body as {
        check_id: string;
        verification?: { type: string; status: string; score?: number };
        verifications?: { type: string; status: string; score?: number }[];
      };
      if (event === 'check.verification_completed' && body.verification) {
        await d.onboarding.onVerification(body.check_id, body.verification, body);
      } else if (event === 'check.completed' && body.verifications) {
        await d.onboarding.onCheckCompleted(body.check_id, body.verifications, body);
      }
      return { status: 204 };
    },
  });

  // ---------------------------------------------------------------- suitability e termos
  route({
    method: 'get',
    path: '/v1/suitability/questionnaire',
    auth: USER,
    accountData: false,
    handler: () => run(async () => ({ body: await d.suitability.questionnaire() })),
  });
  route({
    method: 'post',
    path: '/v1/me/suitability/assessments',
    auth: USER,
    validate: { body: r.assess.body },
    handler: (q, ctx) =>
      run(async () => ({ status: 201, body: await d.suitability.assess(caller(ctx), q.body) })),
  });
  route({
    method: 'get',
    path: '/v1/me/terms/pending',
    auth: USER,
    handler: (_q, ctx) =>
      run(async () => ({ body: { terms: await d.suitability.pending(ctx.actor.id) } })),
  });
  route({
    method: 'post',
    path: '/v1/me/terms/:termsId/accept',
    auth: USER,
    validate: { params: r.acceptTerms.params, body: r.acceptTerms.body },
    handler: (q, ctx) =>
      run(
        async () => (
          await d.suitability.accept(caller(ctx), q.params.termsId, q.body.version),
          { status: 204 }
        ),
      ),
  });

  // ---------------------------------------------------------------- cadastro e conta
  route({
    method: 'get',
    path: '/v1/me/profile',
    auth: USER,
    handler: (_q, ctx) => run(async () => ({ body: await d.accounts.profile(caller(ctx)) })),
  });
  route({
    method: 'post',
    path: '/v1/me/profile/contact-changes',
    auth: USER,
    // RN-CAD-001: a reautenticação é a assinatura eletrônica.
    signature: 'SETTINGS',
    validate: { body: r.contactChange.body },
    handler: (q, ctx) =>
      run(async () => {
        const b = q.body;
        const value = b.kind === 'EMAIL' ? b.email : b.kind === 'PHONE' ? b.phone : b.address;
        if (value === undefined)
          throw new CustomerError(
            400,
            'REQUIRED',
            `Informe o novo valor de ${b.kind}.`,
            b.kind.toLowerCase(),
          );
        return {
          status: 202,
          body: await d.accounts.requestContactChange(
            caller(ctx),
            b.kind,
            value as string | Address,
          ),
        };
      }),
  });
  route({
    method: 'post',
    path: '/v1/me/profile/contact-changes/:changeId/confirm',
    auth: USER,
    validate: { params: r.confirmContactChange.params, body: r.confirmContactChange.body },
    handler: (q, ctx) =>
      run(
        async () => (
          await d.accounts.confirmContactChange(caller(ctx), q.params.changeId, q.body),
          { status: 204 }
        ),
      ),
  });
  route({
    method: 'post',
    path: '/v1/me/profile/reviewed-changes',
    auth: USER,
    validate: { body: r.reviewedChange.body },
    handler: (q, ctx) =>
      run(async () => {
        const b = q.body;
        const value = b.kind === 'NAME' ? b.fullName : b.idDocument;
        if (value === undefined)
          throw new CustomerError(
            400,
            'REQUIRED',
            'Informe o novo valor.',
            b.kind === 'NAME' ? 'fullName' : 'idDocument',
          );
        return {
          status: 202,
          body: await d.accounts.requestReviewedChange(caller(ctx), b.kind, value as string),
        };
      }),
  });
  route({
    method: 'post',
    path: '/v1/me/profile/confirm',
    auth: USER,
    handler: (_q, ctx) =>
      run(async () => ({ body: await d.accounts.confirmRegistration(caller(ctx)) })),
  });
  route({
    method: 'get',
    path: '/v1/me/profile/history',
    auth: USER,
    handler: (_q, ctx) =>
      run(async () => ({ body: { history: await d.accounts.history(caller(ctx)) } })),
  });
  route({
    method: 'get',
    path: '/v1/me/withdrawal-accounts',
    auth: USER,
    handler: (_q, ctx) =>
      run(async () => ({ body: { accounts: await d.accounts.withdrawalAccounts(caller(ctx)) } })),
  });
  route({
    method: 'post',
    path: '/v1/me/withdrawal-accounts',
    auth: USER,
    idempotent: true,
    // RN-ACC-021 + RN-AUTHZ-003: assinatura eletrônica e MFA recente.
    signature: 'SETTINGS',
    stepUp: true,
    validate: { body: r.addWithdrawalAccount.body },
    handler: (q, ctx) =>
      run(async () => ({
        status: 201,
        body: await d.accounts.addWithdrawalAccount(caller(ctx), q.body.pixKey),
      })),
  });
  route({
    method: 'delete',
    path: '/v1/me/withdrawal-accounts/:id',
    auth: USER,
    signature: 'SETTINGS',
    validate: { params: r.removeWithdrawalAccount.params },
    handler: (q, ctx) =>
      run(
        async () => (
          await d.accounts.removeWithdrawalAccount(caller(ctx), q.params.id),
          { status: 204 }
        ),
      ),
  });
  route({
    method: 'post',
    path: '/v1/me/account/close',
    auth: USER,
    handler: (_q, ctx) => run(async () => ({ body: await d.accounts.requestClosure(caller(ctx)) })),
  });
  route({
    method: 'post',
    path: '/v1/me/account/close/cancel',
    auth: USER,
    handler: (_q, ctx) => run(async () => ({ body: await d.accounts.cancelClosure(caller(ctx)) })),
  });

  // ---------------------------------------------------------------- backoffice
  route({
    method: 'get',
    path: '/v1/bo/onboarding/queue',
    auth: ONBOARDING_REVIEW,
    handler: () => run(async () => ({ body: { items: await d.onboarding.reviewQueue() } })),
  });
  for (const [path, decision] of [
    ['approve', 'APPROVE'],
    ['reject', 'REJECT'],
    ['request-changes', 'REQUEST_CHANGES'],
  ] as const) {
    route({
      method: 'post',
      path: `/v1/bo/onboarding/:id/${path}`,
      auth: ONBOARDING_REVIEW,
      validate: { params: r.approve.params, body: r.approve.body },
      handler: (q, ctx) =>
        run(async () => ({
          body: await d.onboarding.review(operator(ctx), q.params.id, decision, q.body.reason),
        })),
    });
  }
  route({
    method: 'post',
    path: '/v1/bo/accounts/:id/block',
    auth: ACCOUNT_BLOCK,
    validate: { params: r.block.params, body: r.block.body },
    handler: (q, ctx) =>
      run(async () => ({
        body: await d.accounts.block(operator(ctx), q.params.id, q.body.reasonCode),
      })),
  });
  route({
    method: 'post',
    path: '/v1/bo/accounts/:id/unblock',
    auth: ADMIN,
    validate: { params: r.unblock.params, body: r.unblock.body },
    handler: (q, ctx) =>
      run(async () => ({
        body: await d.accounts.unblock(operator(ctx), q.params.id, q.body.reasonCode),
      })),
  });
  route({
    method: 'post',
    path: '/v1/bo/terms/:code/versions',
    auth: ADMIN,
    validate: { params: r.publishTerms.params, body: r.publishTerms.body },
    handler: (q) =>
      run(async () => ({
        status: 201,
        body: await d.suitability.publishVersion(q.params.code, q.body),
      })),
  });
  route({
    method: 'get',
    path: '/v1/bo/profile-changes',
    auth: ONBOARDING_REVIEW,
    handler: () => run(async () => ({ body: { items: await d.accounts.reviewQueue() } })),
  });
  route({
    method: 'post',
    path: '/v1/bo/profile-changes/:id/:decision',
    auth: ONBOARDING_REVIEW,
    validate: { params: r.reviewProfileChange.params },
    handler: (q, ctx) =>
      run(
        async () => (
          await d.accounts.reviewChange(
            operator(ctx),
            q.params.id,
            q.params.decision === 'approve',
          ),
          { status: 204 }
        ),
      ),
  });

  // ---------------------------------------------------------------- interna
  route({
    method: 'get',
    path: '/v1/internal/accounts/:id/eligibility',
    auth: { principal: 'service', scopes: ['customer:eligibility'] },
    validate: { params: r.eligibility.params, query: r.eligibility.query },
    handler: (q) =>
      run(async () => ({
        body: await d.accounts.eligibility(q.params.id, q.query.operation as Operation),
      })),
  });
}
