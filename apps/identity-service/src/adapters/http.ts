import { identityServiceHttp } from '@broker/contracts/http/identity-service';
import type { Clock } from '@broker/clock';
import {
  HttpError,
  type ExecutionContext,
  type HandlerResult,
  type RouteDefinition,
  type Service,
} from '@broker/service-kit';
import type { TSchema } from 'typebox';
import express from 'express';
import type { Accounts } from '../application/accounts.js';
import type { Auth } from '../application/auth.js';
import { IdentityError, type Caller } from '../application/context.js';
import type { FactorProof, Factors } from '../application/factors.js';
import type { TokenSigner } from '../application/ports.js';
import type { Recovery } from '../application/recovery.js';
import type { TradingSignature } from '../application/signature.js';

const r = identityServiceHttp.routes;

export interface HttpDeps {
  accounts: Accounts;
  auth: Auth;
  factors: Factors;
  signature: TradingSignature;
  recovery: Recovery;
  signer: TokenSigner;
  clock: Clock;
}

/** Traduz o erro do caso de uso em Problem Details (com `Retry-After` nos bloqueios). */
function toHttp(err: unknown, now: number): never {
  if (!(err instanceof IdentityError)) throw err;
  throw new HttpError(err.status, err.code, err.message, {
    ...(err.field ? { errors: [{ field: err.field, code: err.code, message: err.message }] } : {}),
    ...(err.retryAfter
      ? {
          headers: {
            'Retry-After': String(
              Math.max(1, Math.ceil((err.retryAfter.epochMillis - now) / 1000)),
            ),
          },
        }
      : {}),
  });
}

const callerOf = (ctx: ExecutionContext): Caller => {
  if (!ctx.sessionId) throw new HttpError(401, 'UNAUTHENTICATED', 'Token sem sessão.');
  return {
    userId: ctx.actor.id,
    sessionId: ctx.sessionId,
    realm: ctx.actor.type === 'BACKOFFICE' ? 'backoffice' : 'customers',
    roles: [...ctx.roles],
    ...(ctx.ip ? { ip: ctx.ip } : {}),
    ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
  };
};

const ADMIN = { roles: ['BO_ADMIN'] };
const USER = { principal: 'user' as const };

export function registerHttp(service: Service, d: HttpDeps): void {
  const run = async (fn: () => Promise<HandlerResult>): Promise<HandlerResult> => {
    try {
      return await fn();
    } catch (err) {
      toHttp(err, d.clock.now().epochMillis);
    }
  };
  /** Rotas de autenticação não são comandos financeiros: sem Idempotency-Key. */
  const route = <
    SB extends TSchema | undefined = undefined,
    SQ extends TSchema | undefined = undefined,
    SP extends TSchema | undefined = undefined,
  >(
    def: RouteDefinition<SB, SQ, SP>,
  ) => service.route<SB, SQ, SP>({ idempotent: false, ...def });

  // ---------------------------------------------------------------- públicas
  route({
    method: 'get',
    path: '/.well-known/jwks.json',
    auth: 'public',
    accountData: false,
    handler: async () => ({
      body: await d.signer.jwks(),
      headers: { 'Cache-Control': 'public, max-age=300' },
    }),
  });
  route({
    method: 'post',
    path: '/v1/customers/register',
    auth: 'public',
    validate: { body: r.register.body },
    handler: (req) =>
      run(async () => ({ status: 201, body: await d.accounts.registerCustomer(req.body) })),
  });
  route({
    method: 'post',
    path: '/v1/oauth/authorize',
    auth: 'public',
    validate: { body: r.authorize.body },
    handler: (req, ctx) =>
      run(async () => {
        const b = req.body;
        return {
          body: await d.auth.authorize({
            clientId: b.client_id,
            redirectUri: b.redirect_uri,
            codeChallenge: b.code_challenge,
            codeChallengeMethod: b.code_challenge_method,
            ...(b.scope ? { scope: b.scope } : {}),
            deviceId: b.device_id,
            ...(b.biometric !== undefined ? { biometric: b.biometric } : {}),
            email: b.email,
            password: b.password,
            ...(ctx.ip ? { ip: ctx.ip } : {}),
            ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
          }),
        };
      }),
  });
  route({
    method: 'post',
    path: '/v1/oauth/authorize/mfa',
    auth: 'public',
    validate: { body: r.authorizeMfa.body },
    handler: (req, ctx) =>
      run(async () => {
        const { mfa_token, ...proof } = req.body;
        return {
          body: await d.auth.authorizeMfa(mfa_token, proof as FactorProof, {
            ...(ctx.ip ? { ip: ctx.ip } : {}),
            ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
          }),
        };
      }),
  });
  route({
    method: 'post',
    path: '/v1/oauth/authorize/mfa/webauthn-options',
    auth: 'public',
    validate: { body: r.authorizeMfaWebauthnOptions.body },
    handler: (req) =>
      run(async () => ({ body: await d.auth.mfaWebauthnOptions(req.body.mfa_token) })),
  });

  // O endpoint de token aceita form (RFC 6749) e responde erros no formato OAuth.
  service.use(express.urlencoded({ extended: false, limit: '8kb' }));
  route({
    method: 'post',
    path: '/v1/oauth/token',
    auth: 'public',
    validate: { body: r.token.body },
    handler: async (req) => {
      const b = req.body;
      try {
        const tokens = await (async () => {
          switch (b.grant_type) {
            case 'authorization_code':
              if (!b.code || !b.code_verifier || !b.client_id || !b.redirect_uri)
                throw new IdentityError(
                  400,
                  'invalid_request',
                  'code, code_verifier, client_id e redirect_uri são obrigatórios.',
                );
              return d.auth.exchangeCode({
                code: b.code,
                codeVerifier: b.code_verifier,
                clientId: b.client_id,
                redirectUri: b.redirect_uri,
              });
            case 'refresh_token':
              if (!b.refresh_token || !b.client_id)
                throw new IdentityError(
                  400,
                  'invalid_request',
                  'refresh_token e client_id são obrigatórios.',
                );
              return d.auth.refresh({ refreshToken: b.refresh_token, clientId: b.client_id });
            case 'client_credentials': {
              const basic = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
              const [id, secret] = basic
                ? Buffer.from(basic, 'base64').toString('utf8').split(':')
                : [b.client_id, b.client_secret];
              if (!id || !secret)
                throw new IdentityError(401, 'invalid_client', 'Credenciais do cliente ausentes.');
              return d.auth.clientCredentials({
                clientId: decodeURIComponent(id),
                clientSecret: decodeURIComponent(secret),
                ...(b.scope ? { scope: b.scope } : {}),
              });
            }
          }
        })();
        return { body: tokens, headers: { Pragma: 'no-cache' } };
      } catch (err) {
        if (!(err instanceof IdentityError)) throw err;
        return { status: err.status, body: { error: err.code, error_description: err.message } };
      }
    },
  });
  route({
    method: 'post',
    path: '/v1/oauth/revoke',
    auth: 'public',
    validate: { body: r.revoke.body },
    handler: async (req) => {
      await d.auth.logout(req.body.token);
      return { status: 200, body: {} };
    },
  });

  route({
    method: 'post',
    path: '/v1/recovery',
    auth: 'public',
    validate: { body: r.recoveryRequest.body },
    handler: async (req) => {
      await d.recovery.request(req.body.realm ?? 'customers', req.body.email);
      return { status: 202, body: { status: 'SENT_IF_REGISTERED' } };
    },
  });
  route({
    method: 'post',
    path: '/v1/recovery/methods',
    auth: 'public',
    validate: { body: r.recoveryMethods.body },
    handler: (req) => run(async () => ({ body: await d.recovery.methods(req.body.token) })),
  });
  route({
    method: 'post',
    path: '/v1/recovery/sms',
    auth: 'public',
    validate: { body: r.recoverySms.body },
    handler: (req) =>
      run(async () => (await d.recovery.sendSmsOtp(req.body.token), { status: 204 })),
  });
  route({
    method: 'post',
    path: '/v1/recovery/complete',
    auth: 'public',
    validate: { body: r.recoveryComplete.body },
    handler: (req) =>
      run(async () => {
        const b = req.body;
        await d.recovery.complete({
          token: b.token,
          newPassword: b.newPassword,
          proof: { method: b.method, code: b.code },
        });
        return { status: 204 };
      }),
  });
  route({
    method: 'post',
    path: '/v1/backoffice/invitations/start',
    auth: 'public',
    validate: { body: r.invitationStart.body },
    handler: (req) => run(async () => ({ body: await d.recovery.invitationStart(req.body.token) })),
  });
  route({
    method: 'post',
    path: '/v1/backoffice/invitations/complete',
    auth: 'public',
    validate: { body: r.invitationComplete.body },
    handler: (req) =>
      run(async () => (await d.recovery.invitationComplete(req.body), { status: 204 })),
  });

  // ---------------------------------------------------------------- do usuário logado
  route({
    method: 'get',
    path: '/v1/me/sessions',
    auth: USER,
    handler: (_req, ctx) =>
      run(async () => ({ body: { sessions: await d.auth.sessions(callerOf(ctx)) } })),
  });
  route({
    method: 'delete',
    path: '/v1/me/sessions/:sessionId',
    auth: USER,
    validate: { params: r.revokeSession.params },
    handler: (req, ctx) =>
      run(
        async () => (
          await d.auth.revokeSession(callerOf(ctx), req.params.sessionId),
          { status: 204 }
        ),
      ),
  });
  route({
    method: 'get',
    path: '/v1/me/devices',
    auth: USER,
    handler: (_req, ctx) =>
      run(async () => ({ body: { devices: await d.auth.devices(callerOf(ctx)) } })),
  });
  route({
    method: 'get',
    path: '/v1/me/mfa',
    auth: USER,
    handler: (_req, ctx) =>
      run(async () => ({ body: { factors: await d.factors.list(callerOf(ctx)) } })),
  });
  route({
    method: 'post',
    path: '/v1/me/mfa/totp',
    auth: USER,
    handler: (_req, ctx) =>
      run(async () => {
        const caller = callerOf(ctx);
        return { status: 201, body: await d.factors.enrollTotp(caller, caller.userId) };
      }),
  });
  route({
    method: 'post',
    path: '/v1/me/mfa/totp/confirm',
    auth: USER,
    validate: { body: r.totpConfirm.body },
    handler: (req, ctx) =>
      run(async () => ({ body: await d.factors.confirmTotp(callerOf(ctx), req.body.code) })),
  });
  route({
    method: 'post',
    path: '/v1/me/mfa/webauthn/options',
    auth: USER,
    handler: (_req, ctx) =>
      run(async () => {
        const caller = callerOf(ctx);
        return { body: await d.factors.webauthnRegistrationOptions(caller, caller.userId) };
      }),
  });
  route({
    method: 'post',
    path: '/v1/me/mfa/webauthn',
    auth: USER,
    validate: { body: r.webauthnRegister.body },
    handler: (req, ctx) =>
      run(async () => ({
        body: await d.factors.webauthnRegister(callerOf(ctx), req.body.factorId, req.body.response),
      })),
  });
  route({
    method: 'post',
    path: '/v1/me/mfa/sms',
    auth: USER,
    validate: { body: r.smsEnroll.body },
    handler: (req, ctx) =>
      run(async () => ({
        status: 202,
        body: await d.factors.enrollSms(callerOf(ctx), req.body.phone),
      })),
  });
  route({
    method: 'post',
    path: '/v1/me/mfa/sms/confirm',
    auth: USER,
    validate: { body: r.smsConfirm.body },
    handler: (req, ctx) =>
      run(async () => ({ body: await d.factors.confirmSms(callerOf(ctx), req.body.code) })),
  });
  route({
    method: 'delete',
    path: '/v1/me/mfa/:factorId',
    auth: USER,
    validate: { params: r.removeFactor.params },
    handler: (req, ctx) =>
      run(
        async () => (await d.factors.remove(callerOf(ctx), req.params.factorId), { status: 204 }),
      ),
  });
  route({
    method: 'post',
    path: '/v1/me/step-up',
    auth: USER,
    validate: { body: r.stepUp.body },
    handler: (req, ctx) =>
      run(async () => ({ body: await d.auth.stepUp(callerOf(ctx), req.body as FactorProof) })),
  });
  route({
    method: 'post',
    path: '/v1/me/step-up/webauthn-options',
    auth: USER,
    handler: (_req, ctx) =>
      run(async () => ({ body: await d.auth.stepUpWebauthnOptions(callerOf(ctx)) })),
  });
  route({
    method: 'put',
    path: '/v1/me/trading-signature',
    auth: USER,
    validate: { body: r.setSignature.body },
    handler: (req, ctx) =>
      run(async () => (await d.signature.set(callerOf(ctx), req.body.secret), { status: 204 })),
  });
  route({
    method: 'post',
    path: '/v1/me/trading-signature/verify',
    auth: USER,
    validate: { body: r.verifySignature.body },
    handler: (req, ctx) =>
      run(async () => {
        const b = req.body;
        return {
          body: await d.signature.verify(callerOf(ctx), {
            secret: b.secret,
            scope: b.scope,
            ...(b.rememberInSession !== undefined
              ? { rememberInSession: b.rememberInSession }
              : {}),
          }),
        };
      }),
  });
  route({
    method: 'put',
    path: '/v1/me/settings/desktop-idle',
    auth: USER,
    validate: { body: r.desktopIdle.body },
    handler: (req, ctx) =>
      run(
        async () => (await d.auth.setDesktopIdle(callerOf(ctx), req.body.minutes), { status: 204 }),
      ),
  });

  // ---------------------------------------------------------------- administração (BO_ADMIN)
  route({
    method: 'post',
    path: '/v1/backoffice/users',
    auth: ADMIN,
    validate: { body: r.inviteBackofficeUser.body },
    handler: (req) =>
      run(async () => {
        const { userId } = await d.accounts.inviteBackofficeUser(req.body);
        return { status: 201, body: { userId } };
      }),
  });
  route({
    method: 'put',
    path: '/v1/backoffice/users/:userId/roles',
    auth: ADMIN,
    validate: { params: r.setRoles.params, body: r.setRoles.body },
    handler: (req, ctx) =>
      run(
        async () => (
          await d.accounts.setRoles(callerOf(ctx), req.params.userId, req.body.roles),
          { status: 204 }
        ),
      ),
  });
  route({
    method: 'post',
    path: '/v1/admin/clients',
    auth: ADMIN,
    validate: { body: r.registerClient.body },
    handler: (req) =>
      run(async () => ({ status: 201, body: await d.accounts.registerServiceClient(req.body) })),
  });
  route({
    method: 'post',
    path: '/v1/admin/signing-keys/rotate',
    auth: ADMIN,
    handler: () => run(async () => ({ body: { kid: await d.signer.rotate(d.clock.now()) } })),
  });
}
