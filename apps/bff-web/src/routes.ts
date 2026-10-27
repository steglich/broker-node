// Rotas da Fase 1 do canal web (Contratos §1–§4 e §8) → serviço dono. O BFF não tem regra de
// negócio (RN-BE-071): comandos vão ao dono, que responde com o estado resultante (RN-PAD-011).

export const UPSTREAMS = [
  'identity',
  'customer',
  'ledger',
  'referenceData',
  'marketData',
  'notification',
] as const;
export type Upstream = (typeof UPSTREAMS)[number];

/** Contrato HTTP de cada serviço (`contracts/http/<arquivo>.ts`), para o teste de contrato. */
export const UPSTREAM_CONTRACTS: Record<Upstream, string> = {
  identity: 'identity-service',
  customer: 'customer-service',
  ledger: 'ledger-service',
  referenceData: 'reference-data-service',
  marketData: 'market-data-service',
  notification: 'notification-service',
};

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type SignatureScope = 'ORDERS' | 'WITHDRAWALS' | 'SETTINGS';

export interface ForwardRoute {
  method: Method;
  /** Caminho no BFF (o mesmo que o gateway expõe). */
  path: string;
  service: Upstream;
  /** Caminho no serviço, com os mesmos parâmetros; padrão: o mesmo do BFF. */
  upstream?: string;
  auth: 'user' | 'public';
  /** Comando que exige o token de assinatura do escopo (anexado do cookie, se o canal não mandou). */
  signature?: SignatureScope;
  /** Leitura de dados pessoais: publica `audit.personal_data_accessed` (RN-AUD-BO-001). */
  audit?: string;
  /** Traduz a consulta do canal para a do serviço (ex.: `search` → `q`). */
  mapQuery?: (q: Record<string, string>) => { upstream?: string; query: Record<string, string> };
}

const me = (
  method: Method,
  path: string,
  service: Upstream,
  extra: Partial<ForwardRoute> = {},
): ForwardRoute => ({ method, path, service, auth: 'user', ...extra });

export const ROUTES: readonly ForwardRoute[] = [
  // §1 autenticação e sessão (identity); login, MFA, renovação e saída ficam no token handler.
  {
    method: 'post',
    path: '/v1/auth/register',
    service: 'identity',
    upstream: '/v1/customers/register',
    auth: 'public',
  },
  {
    method: 'post',
    path: '/v1/auth/password-reset',
    service: 'identity',
    upstream: '/v1/recovery',
    auth: 'public',
  },
  {
    method: 'post',
    path: '/v1/auth/password-reset/methods',
    service: 'identity',
    upstream: '/v1/recovery/methods',
    auth: 'public',
  },
  {
    method: 'post',
    path: '/v1/auth/password-reset/sms',
    service: 'identity',
    upstream: '/v1/recovery/sms',
    auth: 'public',
  },
  {
    method: 'post',
    path: '/v1/auth/password-reset/complete',
    service: 'identity',
    upstream: '/v1/recovery/complete',
    auth: 'public',
  },
  me('get', '/v1/me/sessions', 'identity'),
  me('delete', '/v1/me/sessions/:sessionId', 'identity'),
  me('get', '/v1/me/devices', 'identity'),
  me('get', '/v1/me/mfa', 'identity'),
  me('post', '/v1/me/mfa/totp', 'identity'),
  me('post', '/v1/me/mfa/totp/confirm', 'identity'),
  me('post', '/v1/me/mfa/webauthn/options', 'identity'),
  me('post', '/v1/me/mfa/webauthn', 'identity'),
  me('post', '/v1/me/mfa/sms', 'identity'),
  me('post', '/v1/me/mfa/sms/confirm', 'identity'),
  me('delete', '/v1/me/mfa/:factorId', 'identity'),
  me('post', '/v1/me/step-up/webauthn-options', 'identity'),
  me('put', '/v1/me/trading-signature', 'identity'),

  // §2 onboarding e cadastro (customer)
  me('get', '/v1/me/onboarding', 'customer', { audit: 'onboarding_application' }),
  me('put', '/v1/me/onboarding/contact', 'customer'),
  me('post', '/v1/me/onboarding/contact/verify', 'customer'),
  me('put', '/v1/me/onboarding/personal-data', 'customer'),
  me('put', '/v1/me/onboarding/address', 'customer'),
  me('put', '/v1/me/onboarding/financial-profile', 'customer'),
  me('post', '/v1/me/onboarding/documents/upload-url', 'customer'),
  me('post', '/v1/me/onboarding/documents', 'customer'),
  me('post', '/v1/me/onboarding/submit', 'customer'),
  me('get', '/v1/suitability/questionnaire', 'customer'),
  me('post', '/v1/me/suitability/assessments', 'customer'),
  me('get', '/v1/me/terms/pending', 'customer'),
  me('post', '/v1/me/terms/:termsId/accept', 'customer'),
  me('get', '/v1/me/profile', 'customer', { audit: 'customer_profile' }),
  me('post', '/v1/me/profile/contact-changes', 'customer', { signature: 'SETTINGS' }),
  me('post', '/v1/me/profile/contact-changes/:changeId/confirm', 'customer'),
  me('post', '/v1/me/profile/reviewed-changes', 'customer'),
  me('post', '/v1/me/profile/confirm', 'customer'),
  me('get', '/v1/me/profile/history', 'customer', { audit: 'customer_profile_history' }),
  me('get', '/v1/me/withdrawal-accounts', 'customer', { audit: 'withdrawal_account' }),
  me('post', '/v1/me/withdrawal-accounts', 'customer', { signature: 'SETTINGS' }),
  me('delete', '/v1/me/withdrawal-accounts/:id', 'customer', { signature: 'SETTINGS' }),
  me('post', '/v1/me/account/close', 'customer'),
  me('post', '/v1/me/account/close/cancel', 'customer'),

  // §3 financeiro (ledger): saldos com asOf vêm do dono (RN-PAD-010, RN-LED-021).
  me('get', '/v1/me/balances', 'ledger'),
  me('get', '/v1/me/statement', 'ledger'),
  me('get', '/v1/me/statement/future', 'ledger'),
  me('post', '/v1/me/deposits', 'ledger'),
  me('get', '/v1/me/deposits', 'ledger'),
  me('get', '/v1/me/deposits/:id', 'ledger'),
  me('post', '/v1/me/deposits/:id/cancel', 'ledger'),
  me('post', '/v1/me/withdrawals', 'ledger', { signature: 'WITHDRAWALS' }),
  me('get', '/v1/me/withdrawals', 'ledger'),
  me('get', '/v1/me/withdrawals/:id', 'ledger'),
  me('post', '/v1/me/withdrawals/:id/cancel', 'ledger'),

  // §4 instrumentos e dados de mercado (reference-data, market-data)
  me('get', '/v1/instruments', 'referenceData', {
    // `search` vai para a busca; sem ela, o catálogo paginado.
    mapQuery: ({ search, ...rest }) =>
      search
        ? {
            upstream: '/v1/instruments/search',
            query: { q: search, ...(rest['limit'] ? { limit: rest['limit'] } : {}) },
          }
        : { query: rest },
  }),
  me('get', '/v1/instruments/:symbol', 'referenceData', {
    upstream: '/v1/instruments/by-symbol/:symbol',
  }),
  me('get', '/v1/market/quotes', 'marketData', { upstream: '/v1/market-data/external-quotes' }),
  me('get', '/v1/market/indexes', 'marketData', {
    upstream: '/v1/market-data/external-quotes',
    mapQuery: () => ({ query: { symbols: '^BVSP' } }),
  }),
  me('get', '/v1/market/history/:symbol', 'marketData', {
    upstream: '/v1/market-data/history/:symbol',
  }),
  me('get', '/v1/market/calendar', 'referenceData', { upstream: '/v1/calendar' }),

  // §8 notificações
  me('get', '/v1/me/notifications', 'notification'),
  me('post', '/v1/me/notifications/read', 'notification'),
  me('get', '/v1/me/notification-preferences', 'notification'),
  me('put', '/v1/me/notification-preferences', 'notification'),
  me('post', '/v1/me/push-devices', 'notification'),
];

/** Rotas próprias do BFF (token handler e agregação), fora da tabela de repasse. */
export const OWN_ROUTES: readonly { method: Method; path: string; auth: 'user' | 'public' }[] = [
  { method: 'post', path: '/v1/auth/login', auth: 'public' },
  { method: 'post', path: '/v1/auth/mfa/verify', auth: 'public' },
  { method: 'post', path: '/v1/auth/mfa/webauthn-options', auth: 'public' },
  { method: 'post', path: '/v1/auth/token/refresh', auth: 'public' },
  { method: 'post', path: '/v1/auth/logout', auth: 'public' },
  { method: 'get', path: '/v1/auth/session', auth: 'user' },
  { method: 'post', path: '/v1/me/step-up', auth: 'user' },
  { method: 'post', path: '/v1/me/trading-signature/verify', auth: 'user' },
  { method: 'get', path: '/v1/me', auth: 'user' },
];
