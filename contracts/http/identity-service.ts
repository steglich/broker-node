import Type from 'typebox';
import { defineHttpContract } from '../src/define.js';

const Uuid = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const Realm = Type.Union([Type.Literal('customers'), Type.Literal('backoffice')]);
const Code6 = Type.String({ pattern: '^\\d{6}$' });
const Token = Type.String({ minLength: 16, maxLength: 256 });
const SignatureScope = Type.Union([
  Type.Literal('ORDERS'),
  Type.Literal('WITHDRAWALS'),
  Type.Literal('SETTINGS'),
]);
const FactorProof = Type.Union([
  Type.Object({ method: Type.Literal('TOTP'), code: Code6 }),
  Type.Object({
    method: Type.Literal('WEBAUTHN'),
    response: Type.Record(Type.String(), Type.Unknown()),
  }),
]);

const AuthorizeResult = Type.Union([
  Type.Object({
    status: Type.Literal('AUTHORIZED'),
    code: Type.String(),
    redirectUri: Type.String(),
  }),
  Type.Object({
    status: Type.Literal('MFA_REQUIRED'),
    mfaToken: Type.String(),
    methods: Type.Array(Type.String()),
    expiresAt: DateTime,
  }),
]);

export const TokenResponse = Type.Object({
  access_token: Type.String(),
  token_type: Type.Literal('Bearer'),
  expires_in: Type.Integer(),
  scope: Type.String(),
  refresh_token: Type.Optional(Type.String()),
});

const ok204 = { 204: { description: 'Feito.' } };

export const identityServiceHttp = defineHttpContract({
  service: 'identity-service',
  title: 'identity-service',
  version: '1.0.0',
  routes: {
    register: {
      method: 'post',
      path: '/v1/customers/register',
      summary:
        'Cadastro self-service no realm customers (RN-AUTH-001). O backoffice não tem rota de cadastro.',
      auth: 'public',
      body: Type.Object({
        email: Type.String({ minLength: 3, maxLength: 254 }),
        password: Type.String({ minLength: 1, maxLength: 1024 }),
        fullName: Type.String({ minLength: 2, maxLength: 200 }),
        taxId: Type.String({ minLength: 11, maxLength: 14 }),
      }),
      responses: {
        201: { description: 'Usuário criado.', body: Type.Object({ userId: Uuid }) },
        400: {
          description: 'Campo inválido (senha fora da política: TOO_SHORT, CONTAINS_TAX_ID...).',
        },
        409: { description: 'EMAIL_ALREADY_REGISTERED.' },
      },
    },
    authorize: {
      method: 'post',
      path: '/v1/oauth/authorize',
      summary:
        'Authorization Code + PKCE (S256) em fluxo nativo: credenciais do usuário → código ou etapa de MFA (RN-AUTH-010/011).',
      auth: 'public',
      body: Type.Object({
        client_id: Type.String({ minLength: 1, maxLength: 64 }),
        redirect_uri: Type.String({ minLength: 1, maxLength: 512 }),
        code_challenge: Type.String({ minLength: 43, maxLength: 43 }),
        code_challenge_method: Type.Literal('S256'),
        scope: Type.Optional(Type.String({ maxLength: 512 })),
        device_id: Type.String({ minLength: 8, maxLength: 128 }),
        biometric: Type.Optional(Type.Boolean()),
        email: Type.String({ minLength: 3, maxLength: 254 }),
        password: Type.String({ minLength: 1, maxLength: 1024 }),
      }),
      responses: {
        200: { description: 'Código de autorização ou desafio de MFA.', body: AuthorizeResult },
        401: { description: 'INVALID_CREDENTIALS (igual para e-mail inexistente, RN-AUTH-002).' },
        429: { description: 'LOGIN_TEMPORARILY_LOCKED, com Retry-After.' },
      },
    },
    authorizeMfa: {
      method: 'post',
      path: '/v1/oauth/authorize/mfa',
      summary: 'Segunda etapa do login: TOTP ou WebAuthn.',
      auth: 'public',
      body: Type.Intersect([Type.Object({ mfa_token: Token }), FactorProof]),
      responses: {
        200: { description: 'Código de autorização.', body: AuthorizeResult },
        401: { description: 'INVALID_MFA ou MFA_CHALLENGE_EXPIRED.' },
      },
    },
    authorizeMfaWebauthnOptions: {
      method: 'post',
      path: '/v1/oauth/authorize/mfa/webauthn-options',
      summary: 'Desafio WebAuthn da etapa de MFA.',
      auth: 'public',
      body: Type.Object({ mfa_token: Token }),
      responses: { 200: { description: 'PublicKeyCredentialRequestOptions.' } },
    },
    token: {
      method: 'post',
      path: '/v1/oauth/token',
      summary:
        'Endpoint de token (form ou JSON): authorization_code (com code_verifier), refresh_token (rotação, reuso revoga a sessão) e client_credentials (Basic). Erros no formato OAuth.',
      auth: 'public',
      body: Type.Object({
        grant_type: Type.Union([
          Type.Literal('authorization_code'),
          Type.Literal('refresh_token'),
          Type.Literal('client_credentials'),
        ]),
        code: Type.Optional(Type.String()),
        code_verifier: Type.Optional(Type.String()),
        redirect_uri: Type.Optional(Type.String()),
        refresh_token: Type.Optional(Type.String()),
        client_id: Type.Optional(Type.String()),
        client_secret: Type.Optional(Type.String()),
        scope: Type.Optional(Type.String()),
      }),
      responses: {
        200: { description: 'Tokens.', body: TokenResponse },
        400: { description: '{ error: invalid_grant | invalid_request | invalid_scope }' },
        401: { description: '{ error: invalid_client }' },
      },
    },
    revoke: {
      method: 'post',
      path: '/v1/oauth/revoke',
      summary: 'Logout: encerra a sessão do refresh token (sempre 200, RFC 7009).',
      auth: 'public',
      body: Type.Object({ token: Type.String() }),
      responses: { 200: { description: 'Encerrada (ou já não existia).' } },
    },
    jwks: {
      method: 'get',
      path: '/.well-known/jwks.json',
      summary: 'Chaves públicas ES256 (a ativa e as aposentadas recentes).',
      auth: 'public',
      responses: { 200: { description: 'JWKS.' } },
    },
    recoveryRequest: {
      method: 'post',
      path: '/v1/recovery',
      summary: 'Pede o link de recuperação (15 min). Sempre 202 (RN-AUTH-004).',
      auth: 'public',
      body: Type.Object({
        realm: Type.Optional(Realm),
        email: Type.String({ minLength: 3, maxLength: 254 }),
      }),
      responses: { 202: { description: 'Se o e-mail existir, o link foi enviado.' } },
    },
    recoveryMethods: {
      method: 'post',
      path: '/v1/recovery/methods',
      summary: 'Segundos fatores disponíveis para concluir a recuperação.',
      auth: 'public',
      body: Type.Object({ token: Token }),
      responses: {
        200: { description: 'Métodos.', body: Type.Object({ methods: Type.Array(Type.String()) }) },
        400: { description: 'INVALID_LINK.' },
      },
    },
    recoverySms: {
      method: 'post',
      path: '/v1/recovery/sms',
      summary: 'Envia o OTP de recuperação por SMS (simulado).',
      auth: 'public',
      body: Type.Object({ token: Token }),
      responses: ok204,
    },
    recoveryComplete: {
      method: 'post',
      path: '/v1/recovery/complete',
      summary:
        'Nova senha + segundo fator. Revoga todas as sessões e bloqueia a assinatura por 24 h.',
      auth: 'public',
      body: Type.Object({
        token: Token,
        newPassword: Type.String({ minLength: 1, maxLength: 1024 }),
        method: Type.Union([Type.Literal('TOTP'), Type.Literal('SMS')]),
        code: Code6,
      }),
      responses: ok204,
    },
    invitationStart: {
      method: 'post',
      path: '/v1/backoffice/invitations/start',
      summary: 'Convite do backoffice: segredo TOTP a cadastrar no autenticador.',
      auth: 'public',
      body: Type.Object({ token: Token }),
      responses: {
        200: {
          description: 'Segredo e URI otpauth.',
          body: Type.Object({ secret: Type.String(), uri: Type.String() }),
        },
      },
    },
    invitationComplete: {
      method: 'post',
      path: '/v1/backoffice/invitations/complete',
      summary: 'Conclui o convite: senha + código TOTP (MFA forte obrigatório, RN-BO-002).',
      auth: 'public',
      body: Type.Object({
        token: Token,
        password: Type.String({ minLength: 1, maxLength: 1024 }),
        totpCode: Code6,
      }),
      responses: ok204,
    },
    sessions: {
      method: 'get',
      path: '/v1/me/sessions',
      summary: 'Sessões ativas do usuário (RN-AUTH-013).',
      auth: 'user',
      responses: { 200: { description: 'Sessões.' } },
    },
    revokeSession: {
      method: 'delete',
      path: '/v1/me/sessions/:sessionId',
      summary: 'Revoga uma sessão do próprio usuário; os tokens dela deixam de valer.',
      auth: 'user',
      params: Type.Object({ sessionId: Uuid }),
      responses: { ...ok204, 404: { description: 'Sessão inexistente ou de outro usuário.' } },
    },
    devices: {
      method: 'get',
      path: '/v1/me/devices',
      summary: 'Dispositivos já usados pelo usuário.',
      auth: 'user',
      responses: { 200: { description: 'Dispositivos.' } },
    },
    factors: {
      method: 'get',
      path: '/v1/me/mfa',
      summary: 'Fatores de MFA ativos.',
      auth: 'user',
      responses: { 200: { description: 'Fatores.' } },
    },
    totpEnroll: {
      method: 'post',
      path: '/v1/me/mfa/totp',
      summary: 'Começa a ativação do TOTP.',
      auth: 'user',
      responses: { 201: { description: 'Segredo e URI otpauth.' } },
    },
    totpConfirm: {
      method: 'post',
      path: '/v1/me/mfa/totp/confirm',
      summary: 'Confirma o TOTP com um código válido; publica identity.mfa_enabled.',
      auth: 'user',
      body: Type.Object({ code: Code6 }),
      responses: { 200: { description: 'Ativo.' } },
    },
    webauthnOptions: {
      method: 'post',
      path: '/v1/me/mfa/webauthn/options',
      summary: 'Opções de cadastro de chave WebAuthn.',
      auth: 'user',
      responses: { 200: { description: 'PublicKeyCredentialCreationOptions e factorId.' } },
    },
    webauthnRegister: {
      method: 'post',
      path: '/v1/me/mfa/webauthn',
      summary: 'Conclui o cadastro da chave WebAuthn.',
      auth: 'user',
      body: Type.Object({ factorId: Uuid, response: Type.Record(Type.String(), Type.Unknown()) }),
      responses: { 200: { description: 'Ativa.' } },
    },
    smsEnroll: {
      method: 'post',
      path: '/v1/me/mfa/sms',
      summary: 'Telefone de recuperação (fator fraco, só para recuperação): envia um OTP.',
      auth: 'user',
      body: Type.Object({ phone: Type.String({ maxLength: 16 }) }),
      responses: { 202: { description: 'OTP enviado.' } },
    },
    smsConfirm: {
      method: 'post',
      path: '/v1/me/mfa/sms/confirm',
      summary: 'Confirma o telefone de recuperação.',
      auth: 'user',
      body: Type.Object({ code: Code6 }),
      responses: { 200: { description: 'Ativo.' } },
    },
    removeFactor: {
      method: 'delete',
      path: '/v1/me/mfa/:factorId',
      summary: 'Desativa um fator; exige MFA nos últimos 15 min (RN-AUTHZ-003).',
      auth: 'user',
      params: Type.Object({ factorId: Uuid }),
      responses: { ...ok204, 403: { description: 'STEP_UP_REQUIRED.' } },
    },
    stepUp: {
      method: 'post',
      path: '/v1/me/step-up',
      summary: 'Prova um fator agora: novo access token com mfa_time atual (RN-AUTHZ-003).',
      auth: 'user',
      body: FactorProof,
      responses: { 200: { description: 'Access token.', body: TokenResponse } },
    },
    stepUpWebauthnOptions: {
      method: 'post',
      path: '/v1/me/step-up/webauthn-options',
      summary: 'Desafio WebAuthn do step-up.',
      auth: 'user',
      responses: { 200: { description: 'PublicKeyCredentialRequestOptions.' } },
    },
    setSignature: {
      method: 'put',
      path: '/v1/me/trading-signature',
      summary:
        'Cadastra ou redefine a assinatura eletrônica (6 a 8 dígitos); redefinir exige MFA recente (RN-SIG-001/004).',
      auth: 'user',
      body: Type.Object({ secret: Type.String({ maxLength: 16 }) }),
      responses: { ...ok204, 403: { description: 'STEP_UP_REQUIRED.' } },
    },
    verifySignature: {
      method: 'post',
      path: '/v1/me/trading-signature/verify',
      summary:
        'VerifyTradingSignature: token de assinatura do escopo, vinculado à sessão (5 min, ou até 8 h para ordens com rememberInSession).',
      auth: 'user',
      body: Type.Object({
        secret: Type.String({ maxLength: 16 }),
        scope: SignatureScope,
        rememberInSession: Type.Optional(Type.Boolean()),
      }),
      responses: {
        200: {
          description: 'Token de assinatura (header X-Trading-Signature nos comandos).',
          body: Type.Object({
            signatureToken: Type.String(),
            scope: SignatureScope,
            expiresAt: DateTime,
          }),
        },
        401: { description: 'INVALID_SIGNATURE.' },
        423: { description: 'SIGNATURE_LOCKED, SIGNATURE_RESET_REQUIRED ou SIGNATURE_BLOCKED.' },
      },
    },
    desktopIdle: {
      method: 'put',
      path: '/v1/me/settings/desktop-idle',
      summary: 'Inatividade do desktop, de 120 a 480 minutos (RN-AUTH-012).',
      auth: 'user',
      body: Type.Object({ minutes: Type.Integer() }),
      responses: ok204,
    },
    inviteBackofficeUser: {
      method: 'post',
      path: '/v1/backoffice/users',
      summary: 'Convida um usuário do backoffice com papéis (BO_ADMIN; segregação RN-BO-001).',
      auth: 'user',
      body: Type.Object({
        email: Type.String({ minLength: 3, maxLength: 254 }),
        fullName: Type.String({ minLength: 2, maxLength: 200 }),
        roles: Type.Array(Type.String(), { minItems: 1, maxItems: 7 }),
      }),
      responses: {
        201: { description: 'Convidado.', body: Type.Object({ userId: Uuid }) },
        422: { description: 'SEGREGATION_OF_DUTIES.' },
      },
    },
    setRoles: {
      method: 'put',
      path: '/v1/backoffice/users/:userId/roles',
      summary: 'Troca os papéis (BO_ADMIN); BO_AUDITOR não acumula outro papel.',
      auth: 'user',
      params: Type.Object({ userId: Uuid }),
      body: Type.Object({ roles: Type.Array(Type.String(), { minItems: 1, maxItems: 7 }) }),
      responses: { ...ok204, 422: { description: 'SEGREGATION_OF_DUTIES.' } },
    },
    registerClient: {
      method: 'post',
      path: '/v1/admin/clients',
      summary: 'Cliente OAuth de serviço (client credentials) com escopos mínimos (BO_ADMIN).',
      auth: 'user',
      body: Type.Object({
        clientId: Type.String({ pattern: '^[a-z][a-z0-9-]{2,63}$' }),
        scopes: Type.Array(Type.String({ pattern: '^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$' }), {
          minItems: 1,
        }),
      }),
      responses: {
        201: {
          description: 'O segredo aparece só nesta resposta.',
          body: Type.Object({ clientId: Type.String(), clientSecret: Type.String() }),
        },
      },
    },
    rotateKeys: {
      method: 'post',
      path: '/v1/admin/signing-keys/rotate',
      summary: 'Rotaciona a chave de assinatura dos tokens (BO_ADMIN).',
      auth: 'user',
      responses: {
        200: { description: 'kid da nova chave.', body: Type.Object({ kid: Type.String() }) },
      },
    },
  },
});

export default identityServiceHttp;
