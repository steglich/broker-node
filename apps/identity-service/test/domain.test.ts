// Regras puras: política de senha, bloqueios, sessões, assinatura, segregação e PKCE.
import { Instant } from '@broker/domain-kernel';
import { describe, expect, it } from 'vitest';
import { checkPassword } from '../src/domain/password-policy.js';
import { pkceMatches, s256 } from '../src/domain/pkce.js';
import {
  canRefresh,
  loginBlockedUntil,
  NO_FAILURES,
  registerLoginFailure,
  registerSignatureFailure,
  roleConflict,
  signatureAvailability,
  signatureTokenTtlMs,
  type LoginThrottle,
  type SignatureState,
} from '../src/domain/policies.js';

const t0 = Instant.parse('2026-01-05T13:00:00Z');
const at = (ms: number) => t0.plusMillis(ms);
const MIN = 60_000;

describe('política de senha (RN-AUTH-001)', () => {
  const ctx = { email: 'maria.souza@exemplo.com', fullName: 'Maria Souza', taxId: '52998224725' };

  it('aceita frase longa sem regra de composição', () => {
    expect(checkPassword('cavalo correto bateria grampo', ctx)).toBeNull();
  });

  it('recusa curta, comum, com e-mail, nome ou CPF', () => {
    expect(checkPassword('abc12345', ctx)).toBe('TOO_SHORT');
    expect(checkPassword('Flamengo2026!', ctx)).toBe('COMMON_PASSWORD');
    expect(checkPassword('password1234', ctx)).toBe('COMMON_PASSWORD');
    expect(checkPassword('xx maria.souza yy', ctx)).toBe('CONTAINS_EMAIL');
    expect(checkPassword('minha senha é SOUZA!', ctx)).toBe('CONTAINS_NAME');
    expect(checkPassword('nova-529.982.247-25', ctx)).toBe('CONTAINS_TAX_ID');
    expect(checkPassword('529982247250000', ctx)).toBe('CONTAINS_TAX_ID');
  });
});

describe('bloqueio de login (RN-AUTH-002)', () => {
  it('atraso progressivo a partir da 5ª falha e bloqueio de 30 min na 10ª', () => {
    let t: LoginThrottle = NO_FAILURES;
    let now = t0;
    for (let i = 1; i <= 9; i++) {
      const r = registerLoginFailure(t, now);
      expect(r.locked).toBe(false);
      t = r.next;
      const blocked = loginBlockedUntil(t, now);
      if (i < 5) expect(blocked).toBeNull();
      else expect(blocked?.epochMillis).toBe(now.epochMillis + 1000 * 2 ** (i - 5));
      now = blocked ?? now;
    }
    const tenth = registerLoginFailure(t, now);
    expect(tenth).toMatchObject({ locked: true, attempt: 10 });
    expect(loginBlockedUntil(tenth.next, now)?.epochMillis).toBe(now.epochMillis + 30 * MIN);
    expect(loginBlockedUntil(tenth.next, now.plusMillis(30 * MIN))).toBeNull();
  });
});

describe('sessões (RN-AUTH-012, RN-BO-003)', () => {
  const session = (
    channel: 'WEB' | 'DESKTOP' | 'BACKOFFICE' | 'MOBILE',
    desktopIdleMs: number | null = null,
  ) => ({
    channel,
    desktopIdleMs,
    lastActivityAt: t0,
    expiresAt: at(30 * 24 * 60 * MIN),
    revokedAt: null,
  });

  it('inatividade: web 30 min, desktop 2 h (até 8 h), backoffice 15 min, mobile sem limite', () => {
    expect(canRefresh(session('WEB'), at(30 * MIN))).toBeNull();
    expect(canRefresh(session('WEB'), at(31 * MIN))).toBe('IDLE_TIMEOUT');
    expect(canRefresh(session('DESKTOP'), at(119 * MIN))).toBeNull();
    expect(canRefresh(session('DESKTOP'), at(121 * MIN))).toBe('IDLE_TIMEOUT');
    expect(canRefresh(session('DESKTOP', 480 * MIN), at(300 * MIN))).toBeNull();
    expect(canRefresh(session('DESKTOP', 900 * MIN), at(481 * MIN))).toBe('IDLE_TIMEOUT');
    expect(canRefresh(session('BACKOFFICE'), at(16 * MIN))).toBe('IDLE_TIMEOUT');
    expect(canRefresh(session('MOBILE'), at(10 * 24 * 60 * MIN))).toBeNull();
  });
});

describe('assinatura eletrônica (RN-SIG-003/004)', () => {
  const fresh: SignatureState = {
    failures: 0,
    lockedUntil: null,
    resetRequired: false,
    blockedUntil: null,
  };

  it('3 erros bloqueiam 30 min; 6, até redefinir', () => {
    let s = fresh;
    for (let i = 0; i < 3; i++) s = registerSignatureFailure(s, t0);
    expect(signatureAvailability(s, t0)?.refusal).toBe('SIGNATURE_LOCKED');
    expect(signatureAvailability(s, at(30 * MIN))).toBeNull();
    for (let i = 0; i < 3; i++) s = registerSignatureFailure(s, at(31 * MIN));
    expect(signatureAvailability(s, at(10 * 24 * 60 * MIN))?.refusal).toBe(
      'SIGNATURE_RESET_REQUIRED',
    );
  });

  it('token de 5 min; "lembrar" só para ordens, até 8 h e dentro da sessão', () => {
    expect(signatureTokenTtlMs('WITHDRAWALS', true, 24 * 60 * MIN)).toBe(5 * MIN);
    expect(signatureTokenTtlMs('ORDERS', true, 24 * 60 * MIN)).toBe(8 * 60 * MIN);
    expect(signatureTokenTtlMs('ORDERS', true, 60 * MIN)).toBe(60 * MIN);
  });
});

describe('segregação e PKCE', () => {
  it('BO_AUDITOR não acumula papel (RN-BO-001)', () => {
    expect(roleConflict(['BO_AUDITOR'])).toBeNull();
    expect(roleConflict(['BO_FINANCE', 'BO_RISK'])).toBeNull();
    expect(roleConflict(['BO_AUDITOR', 'BO_FINANCE'])).toMatch(/segregação/);
  });

  it('S256 do RFC 7636 (vetor do apêndice B)', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(s256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(pkceMatches(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(pkceMatches('curto', s256('curto'))).toBe(false);
  });
});
