// bff-web (catálogo §22–24, D9): token handler do canal web e as rotas da Fase 1 (Contratos §1–§4,
// §8). As rotas repassadas têm o contrato do serviço dono; aqui ficam o caminho público, o dono e,
// nas próprias do BFF (login, MFA, sessão, agregação), os corpos.
import Type from 'typebox';
import { defineHttpContract, type HttpRouteContract } from '../src/define.js';

const DateTime = Type.String({ format: 'date-time' });
const Code6 = Type.String({ pattern: '^\\d{6}$' });

export const Login = Type.Object({
  email: Type.String({ minLength: 3, maxLength: 254 }),
  password: Type.String({ minLength: 1, maxLength: 1024 }),
});

export const FactorProof = Type.Union([
  Type.Object({ method: Type.Literal('TOTP'), code: Code6 }),
  Type.Object({
    method: Type.Literal('WEBAUTHN'),
    response: Type.Record(Type.String(), Type.Unknown()),
  }),
]);

/** Resultado do login: só o estado e o anti-CSRF; os tokens ficam nos cookies HttpOnly. */
export const AuthResult = Type.Union([
  Type.Object({
    status: Type.Literal('AUTHENTICATED'),
    expiresIn: Type.Integer(),
    csrfToken: Type.String(),
  }),
  Type.Object({
    status: Type.Literal('MFA_REQUIRED'),
    methods: Type.Array(Type.String()),
    expiresAt: DateTime,
  }),
]);

const forwarded = (
  method: HttpRouteContract['method'],
  path: string,
  owner: string,
  auth: 'user' | 'public' = 'user',
): HttpRouteContract => ({
  method,
  path,
  summary: `Repassada ao ${owner} (contrato do dono).`,
  auth,
  responses: { 200: { description: 'Resposta do serviço dono, como veio.' } },
});

export const bffWebHttp = defineHttpContract({
  service: 'bff-web',
  title: 'BFF web',
  version: '1.0.0',
  routes: {
    login: {
      method: 'post',
      path: '/v1/auth/login',
      summary:
        'Login (Authorization Code + PKCE conduzido pelo BFF): tokens em cookies HttpOnly/Secure/SameSite=Strict (RN-AUTH-010).',
      auth: 'public',
      body: Login,
      responses: {
        200: {
          description: 'Autenticado ou desafio de MFA; nenhum token no corpo.',
          body: AuthResult,
        },
        401: { description: 'INVALID_CREDENTIALS.' },
        429: { description: 'LOGIN_TEMPORARILY_LOCKED.' },
      },
    },
    mfaVerify: {
      method: 'post',
      path: '/v1/auth/mfa/verify',
      summary: 'Segunda etapa do login (o desafio fica no cookie cifrado do BFF).',
      auth: 'public',
      body: FactorProof,
      responses: {
        200: { description: 'Autenticado.', body: AuthResult },
        401: { description: 'INVALID_MFA, MFA_CHALLENGE_EXPIRED ou LOGIN_EXPIRED.' },
      },
    },
    mfaWebauthnOptions: {
      method: 'post',
      path: '/v1/auth/mfa/webauthn-options',
      summary: 'Desafio WebAuthn da etapa de MFA.',
      auth: 'public',
      responses: { 200: { description: 'PublicKeyCredentialRequestOptions.' } },
    },
    refresh: {
      method: 'post',
      path: '/v1/auth/token/refresh',
      summary: 'Renova os cookies com o refresh token (rotação; reuso encerra a sessão).',
      auth: 'public',
      responses: {
        200: { description: 'Renovado.', body: AuthResult },
        401: { description: 'Sessão encerrada: cookies limpos.' },
      },
    },
    logout: {
      method: 'post',
      path: '/v1/auth/logout',
      summary: 'Revoga a sessão no identity e limpa os cookies.',
      auth: 'public',
      responses: { 204: { description: 'Encerrada.' } },
    },
    session: {
      method: 'get',
      path: '/v1/auth/session',
      summary: 'Quem está logado e o token anti-CSRF (para o app recarregado).',
      auth: 'user',
      responses: {
        200: {
          description: 'Sessão.',
          body: Type.Object({
            userId: Type.String(),
            accountId: Type.Union([Type.String(), Type.Null()]),
            csrfToken: Type.String(),
            expiresAt: DateTime,
          }),
        },
      },
    },
    stepUp: {
      method: 'post',
      path: '/v1/me/step-up',
      summary: 'Step-up (RN-AUTHZ-003): o access token novo vai para o cookie.',
      auth: 'user',
      body: FactorProof,
      responses: {
        200: {
          description: 'Feito.',
          body: Type.Object({ status: Type.Literal('STEPPED_UP'), expiresIn: Type.Integer() }),
        },
      },
    },
    verifySignature: {
      method: 'post',
      path: '/v1/me/trading-signature/verify',
      summary:
        'Assinatura eletrônica: o token de curta duração fica num cookie HttpOnly do escopo e é anexado aos comandos (RN-SIG-003).',
      auth: 'user',
      body: Type.Object({
        secret: Type.String({ maxLength: 16 }),
        scope: Type.Union(['ORDERS', 'WITHDRAWALS', 'SETTINGS'].map((s) => Type.Literal(s))),
        rememberInSession: Type.Optional(Type.Boolean()),
      }),
      responses: {
        200: {
          description: 'Validade do token (que não aparece no corpo).',
          body: Type.Object({ scope: Type.String(), expiresAt: DateTime }),
        },
      },
    },
    me: {
      method: 'get',
      path: '/v1/me',
      summary:
        'Painel inicial: perfil, saldos (com asOf) e notificações não lidas em chamadas paralelas, uma por dono (sem N+1).',
      auth: 'user',
      responses: {
        200: { description: 'Agregado; seção indisponível vem null e em `unavailable`.' },
      },
    },

    // Repassadas (Contratos §1–§4, §8).
    register: forwarded('post', '/v1/auth/register', 'identity-service', 'public'),
    passwordReset: forwarded('post', '/v1/auth/password-reset', 'identity-service', 'public'),
    passwordResetMethods: forwarded(
      'post',
      '/v1/auth/password-reset/methods',
      'identity-service',
      'public',
    ),
    passwordResetSms: forwarded(
      'post',
      '/v1/auth/password-reset/sms',
      'identity-service',
      'public',
    ),
    passwordResetComplete: forwarded(
      'post',
      '/v1/auth/password-reset/complete',
      'identity-service',
      'public',
    ),
    sessions: forwarded('get', '/v1/me/sessions', 'identity-service'),
    revokeSession: forwarded('delete', '/v1/me/sessions/:sessionId', 'identity-service'),
    devices: forwarded('get', '/v1/me/devices', 'identity-service'),
    mfa: forwarded('get', '/v1/me/mfa', 'identity-service'),
    mfaTotp: forwarded('post', '/v1/me/mfa/totp', 'identity-service'),
    mfaTotpConfirm: forwarded('post', '/v1/me/mfa/totp/confirm', 'identity-service'),
    mfaWebauthnOptionsMe: forwarded('post', '/v1/me/mfa/webauthn/options', 'identity-service'),
    mfaWebauthn: forwarded('post', '/v1/me/mfa/webauthn', 'identity-service'),
    mfaSms: forwarded('post', '/v1/me/mfa/sms', 'identity-service'),
    mfaSmsConfirm: forwarded('post', '/v1/me/mfa/sms/confirm', 'identity-service'),
    mfaDelete: forwarded('delete', '/v1/me/mfa/:factorId', 'identity-service'),
    stepUpWebauthnOptions: forwarded('post', '/v1/me/step-up/webauthn-options', 'identity-service'),
    setSignature: forwarded('put', '/v1/me/trading-signature', 'identity-service'),
    onboarding: forwarded('get', '/v1/me/onboarding', 'customer-service'),
    onboardingContact: forwarded('put', '/v1/me/onboarding/contact', 'customer-service'),
    onboardingContactVerify: forwarded(
      'post',
      '/v1/me/onboarding/contact/verify',
      'customer-service',
    ),
    onboardingPersonal: forwarded('put', '/v1/me/onboarding/personal-data', 'customer-service'),
    onboardingAddress: forwarded('put', '/v1/me/onboarding/address', 'customer-service'),
    onboardingFinancial: forwarded(
      'put',
      '/v1/me/onboarding/financial-profile',
      'customer-service',
    ),
    onboardingUploadUrl: forwarded(
      'post',
      '/v1/me/onboarding/documents/upload-url',
      'customer-service',
    ),
    onboardingDocuments: forwarded('post', '/v1/me/onboarding/documents', 'customer-service'),
    onboardingSubmit: forwarded('post', '/v1/me/onboarding/submit', 'customer-service'),
    questionnaire: forwarded('get', '/v1/suitability/questionnaire', 'customer-service'),
    assessments: forwarded('post', '/v1/me/suitability/assessments', 'customer-service'),
    termsPending: forwarded('get', '/v1/me/terms/pending', 'customer-service'),
    termsAccept: forwarded('post', '/v1/me/terms/:termsId/accept', 'customer-service'),
    profile: forwarded('get', '/v1/me/profile', 'customer-service'),
    contactChanges: forwarded('post', '/v1/me/profile/contact-changes', 'customer-service'),
    contactChangeConfirm: forwarded(
      'post',
      '/v1/me/profile/contact-changes/:changeId/confirm',
      'customer-service',
    ),
    reviewedChanges: forwarded('post', '/v1/me/profile/reviewed-changes', 'customer-service'),
    profileConfirm: forwarded('post', '/v1/me/profile/confirm', 'customer-service'),
    profileHistory: forwarded('get', '/v1/me/profile/history', 'customer-service'),
    withdrawalAccounts: forwarded('get', '/v1/me/withdrawal-accounts', 'customer-service'),
    addWithdrawalAccount: forwarded('post', '/v1/me/withdrawal-accounts', 'customer-service'),
    removeWithdrawalAccount: forwarded(
      'delete',
      '/v1/me/withdrawal-accounts/:id',
      'customer-service',
    ),
    closeAccount: forwarded('post', '/v1/me/account/close', 'customer-service'),
    cancelClose: forwarded('post', '/v1/me/account/close/cancel', 'customer-service'),
    balances: forwarded('get', '/v1/me/balances', 'ledger-service'),
    statement: forwarded('get', '/v1/me/statement', 'ledger-service'),
    statementFuture: forwarded('get', '/v1/me/statement/future', 'ledger-service'),
    createDeposit: forwarded('post', '/v1/me/deposits', 'ledger-service'),
    deposits: forwarded('get', '/v1/me/deposits', 'ledger-service'),
    deposit: forwarded('get', '/v1/me/deposits/:id', 'ledger-service'),
    cancelDeposit: forwarded('post', '/v1/me/deposits/:id/cancel', 'ledger-service'),
    createWithdrawal: forwarded('post', '/v1/me/withdrawals', 'ledger-service'),
    withdrawals: forwarded('get', '/v1/me/withdrawals', 'ledger-service'),
    withdrawal: forwarded('get', '/v1/me/withdrawals/:id', 'ledger-service'),
    cancelWithdrawal: forwarded('post', '/v1/me/withdrawals/:id/cancel', 'ledger-service'),
    instruments: forwarded('get', '/v1/instruments', 'reference-data-service'),
    instrument: forwarded('get', '/v1/instruments/:symbol', 'reference-data-service'),
    quotes: forwarded('get', '/v1/market/quotes', 'market-data-service'),
    indexes: forwarded('get', '/v1/market/indexes', 'market-data-service'),
    history: forwarded('get', '/v1/market/history/:symbol', 'market-data-service'),
    calendar: forwarded('get', '/v1/market/calendar', 'reference-data-service'),
    notifications: forwarded('get', '/v1/me/notifications', 'notification-service'),
    notificationsRead: forwarded('post', '/v1/me/notifications/read', 'notification-service'),
    preferences: forwarded('get', '/v1/me/notification-preferences', 'notification-service'),
    putPreferences: forwarded('put', '/v1/me/notification-preferences', 'notification-service'),
    pushDevices: forwarded('post', '/v1/me/push-devices', 'notification-service'),
  },
});

export default bffWebHttp;
