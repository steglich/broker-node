import type { Instant } from '@broker/domain-kernel';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type Realm = 'customers' | 'backoffice';
export type Channel = 'WEB' | 'DESKTOP' | 'MOBILE' | 'BACKOFFICE';

// ------------------------------------------------------------------ bloqueio de login (RN-AUTH-002)

export const LOGIN_DELAY_AFTER = 5;
export const LOGIN_LOCK_AFTER = 10;
export const LOGIN_LOCK_MS = 30 * MINUTE;

/**
 * Estado do bloqueio por **e-mail** (hash), exista o usuário ou não: assim o e-mail inexistente
 * passa pelo mesmo atraso e pelo mesmo bloqueio, e a resposta não revela nada.
 */
export interface LoginThrottle {
  failures: number;
  lastFailureAt: Instant | null;
  lockedUntil: Instant | null;
}

export const NO_FAILURES: LoginThrottle = { failures: 0, lastFailureAt: null, lockedUntil: null };

/** Atraso progressivo a partir da 5ª falha: 1 s, 2 s, 4 s, 8 s, 16 s. */
export const loginDelayMs = (failures: number): number =>
  failures < LOGIN_DELAY_AFTER ? 0 : 1000 * 2 ** (failures - LOGIN_DELAY_AFTER);

/** Quando a próxima tentativa é aceita; `null` = agora. */
export function loginBlockedUntil(t: LoginThrottle, now: Instant): Instant | null {
  if (t.lockedUntil && now.isBefore(t.lockedUntil)) return t.lockedUntil;
  const delay = loginDelayMs(t.failures);
  if (delay > 0 && t.lastFailureAt) {
    const next = t.lastFailureAt.plusMillis(delay);
    if (now.isBefore(next)) return next;
  }
  return null;
}

/**
 * Registra uma falha. Na 10ª seguida, bloqueia por 30 min (e o titular recebe e-mail): o contador
 * zera, e depois do bloqueio o ciclo de atrasos recomeça.
 */
export function registerLoginFailure(
  t: LoginThrottle,
  now: Instant,
): { next: LoginThrottle; locked: boolean; attempt: number } {
  const attempt = t.failures + 1;
  if (attempt >= LOGIN_LOCK_AFTER) {
    return {
      next: { failures: 0, lastFailureAt: now, lockedUntil: now.plusMillis(LOGIN_LOCK_MS) },
      locked: true,
      attempt,
    };
  }
  return {
    next: { failures: attempt, lastFailureAt: now, lockedUntil: null },
    locked: false,
    attempt,
  };
}

// ------------------------------------------------------------------ sessões (Autenticação §4)

export const ACCESS_TOKEN_TTL_MS = 10 * MINUTE;
export const AUTH_CODE_TTL_MS = MINUTE;
export const MFA_CHALLENGE_TTL_MS = 5 * MINUTE;
/** RN-AUTHZ-003: step-up = MFA nos últimos 15 minutos. */
export const STEP_UP_WINDOW_MS = 15 * MINUTE;

export const DESKTOP_IDLE_DEFAULT_MS = 2 * HOUR;
export const DESKTOP_IDLE_MAX_MS = 8 * HOUR;

/** Inatividade máxima por canal (RN-AUTH-012, RN-BO-003); `null` = sem limite no servidor. */
export function idleLimitMs(channel: Channel, desktopIdleMs?: number | null): number | null {
  switch (channel) {
    case 'WEB':
      return 30 * MINUTE;
    case 'DESKTOP':
      return Math.min(desktopIdleMs ?? DESKTOP_IDLE_DEFAULT_MS, DESKTOP_IDLE_MAX_MS);
    case 'BACKOFFICE':
      return 15 * MINUTE;
    case 'MOBILE':
      // O desbloqueio por biometria a cada abertura é do aplicativo.
      return null;
  }
}

/** Validade do refresh token: 30 dias, 90 no mobile com biometria; backoffice, sessão de 8 h. */
export function refreshTtlMs(channel: Channel, biometric = false): number {
  if (channel === 'BACKOFFICE') return 8 * HOUR;
  return channel === 'MOBILE' && biometric ? 90 * DAY : 30 * DAY;
}

export type RefreshRefusal = 'IDLE_TIMEOUT' | 'SESSION_EXPIRED' | 'SESSION_REVOKED';

export function canRefresh(
  s: {
    channel: Channel;
    desktopIdleMs: number | null;
    lastActivityAt: Instant;
    expiresAt: Instant;
    revokedAt: Instant | null;
  },
  now: Instant,
): RefreshRefusal | null {
  if (s.revokedAt) return 'SESSION_REVOKED';
  if (!now.isBefore(s.expiresAt)) return 'SESSION_EXPIRED';
  const idle = idleLimitMs(s.channel, s.desktopIdleMs);
  if (idle !== null && now.epochMillis - s.lastActivityAt.epochMillis > idle) return 'IDLE_TIMEOUT';
  return null;
}

export const hasRecentMfa = (mfaAt: Instant | null, now: Instant): boolean =>
  mfaAt !== null && now.epochMillis - mfaAt.epochMillis <= STEP_UP_WINDOW_MS;

// ------------------------------------------------------------------ assinatura eletrônica (RN-SIG-*)

export type SignatureScope = 'ORDERS' | 'WITHDRAWALS' | 'SETTINGS';
export const SIGNATURE_SCOPES: readonly SignatureScope[] = ['ORDERS', 'WITHDRAWALS', 'SETTINGS'];

export const SIGNATURE_TOKEN_TTL_MS = 5 * MINUTE;
export const SIGNATURE_REMEMBER_MAX_MS = 8 * HOUR;
export const SIGNATURE_SOFT_LOCK_AFTER = 3;
export const SIGNATURE_HARD_LOCK_AFTER = 6;
export const SIGNATURE_SOFT_LOCK_MS = 30 * MINUTE;
/** RN-AUTH-004: depois da recuperação de acesso, assinatura bloqueada por 24 h. */
export const SIGNATURE_RECOVERY_BLOCK_MS = DAY;

export interface SignatureState {
  failures: number;
  lockedUntil: Instant | null;
  /** Bloqueio até redefinir com MFA (6 erros). */
  resetRequired: boolean;
  /** Bloqueio por recuperação de acesso. */
  blockedUntil: Instant | null;
}

export type SignatureRefusal =
  'SIGNATURE_RESET_REQUIRED' | 'SIGNATURE_LOCKED' | 'SIGNATURE_BLOCKED';

export function signatureAvailability(
  s: SignatureState,
  now: Instant,
): { refusal: SignatureRefusal; until: Instant | null } | null {
  if (s.resetRequired) return { refusal: 'SIGNATURE_RESET_REQUIRED', until: null };
  if (s.blockedUntil && now.isBefore(s.blockedUntil))
    return { refusal: 'SIGNATURE_BLOCKED', until: s.blockedUntil };
  if (s.lockedUntil && now.isBefore(s.lockedUntil))
    return { refusal: 'SIGNATURE_LOCKED', until: s.lockedUntil };
  return null;
}

/** Erro de assinatura: 3 → 30 min; 6 → até redefinir com MFA (RN-SIG-004). */
export function registerSignatureFailure(s: SignatureState, now: Instant): SignatureState {
  const failures = s.failures + 1;
  if (failures >= SIGNATURE_HARD_LOCK_AFTER) return { ...s, failures, resetRequired: true };
  if (failures === SIGNATURE_SOFT_LOCK_AFTER)
    return { ...s, failures, lockedUntil: now.plusMillis(SIGNATURE_SOFT_LOCK_MS) };
  return { ...s, failures };
}

/**
 * Validade do token de assinatura (RN-SIG-003): 5 min; "lembrar nesta sessão" só para ordens, até
 * 8 h e nunca além da sessão.
 */
export function signatureTokenTtlMs(
  scope: SignatureScope,
  remember: boolean,
  sessionRemainingMs: number,
): number {
  const wanted =
    remember && scope === 'ORDERS' ? SIGNATURE_REMEMBER_MAX_MS : SIGNATURE_TOKEN_TTL_MS;
  return Math.max(0, Math.min(wanted, sessionRemainingMs));
}

export const isSignatureSecret = (secret: string): boolean => /^\d{6,8}$/.test(secret);

// ------------------------------------------------------------------ RBAC do backoffice (RN-BO-001)

export const BACKOFFICE_ROLES = [
  'BO_ONBOARDING',
  'BO_FINANCE',
  'BO_MARKET',
  'BO_RISK',
  'BO_SUPPORT',
  'BO_ADMIN',
  'BO_AUDITOR',
] as const;
export type BackofficeRole = (typeof BACKOFFICE_ROLES)[number];

export const isBackofficeRole = (r: string): r is BackofficeRole =>
  (BACKOFFICE_ROLES as readonly string[]).includes(r);

/** Segregação de funções: `BO_AUDITOR` não acumula nenhum outro papel. */
export function roleConflict(roles: readonly string[]): string | null {
  const set = new Set(roles);
  if (set.has('BO_AUDITOR') && set.size > 1)
    return 'BO_AUDITOR não pode acumular outro papel (segregação de funções, RN-BO-001).';
  return null;
}

/** Escopos que o cliente pode pedir (Autenticação §5.2). */
export const CUSTOMER_SCOPES = [
  'profile:read',
  'profile:write',
  'portfolio:read',
  'orders:read',
  'orders:write',
  'funds:write',
  'market:read',
  'tax:read',
  'tax:write',
] as const;
