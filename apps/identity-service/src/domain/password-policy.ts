import { COMMON_PASSWORDS } from './common-passwords.js';

export const MIN_PASSWORD_LENGTH = 10;

export type PasswordViolation =
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'COMMON_PASSWORD'
  | 'CONTAINS_EMAIL'
  | 'CONTAINS_NAME'
  | 'CONTAINS_TAX_ID';

/** O que a senha não pode conter (RN-AUTH-001). */
export interface PasswordContext {
  email: string;
  fullName?: string | null;
  taxId?: string | null;
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const digits = (s: string) => s.replace(/\D/g, '');

/**
 * Política de senha (RN-AUTH-001): no mínimo 10 caracteres, fora da lista de vazadas/comuns e sem
 * e-mail, nome ou CPF. Não há regra de composição (maiúscula, símbolo...): ela empurra as pessoas
 * para senhas previsíveis. Devolve a primeira violação, ou `null`.
 */
export function checkPassword(password: string, ctx: PasswordContext): PasswordViolation | null {
  if ([...password].length < MIN_PASSWORD_LENGTH) return 'TOO_SHORT';
  // Limite de bytes: argon2 aceita mais, mas uma senha de megabytes vira negação de serviço.
  if (Buffer.byteLength(password, 'utf8') > 256) return 'TOO_LONG';
  const p = fold(password);
  if (COMMON_PASSWORDS.has(p) || COMMON_PASSWORDS.has(p.replace(/[\d\W_]+$/, ''))) {
    return 'COMMON_PASSWORD';
  }
  const email = fold(ctx.email.trim());
  const local = email.split('@')[0] ?? '';
  if (p.includes(email) || (local.length >= 4 && p.includes(local))) return 'CONTAINS_EMAIL';
  // Cada parte do nome com 3+ letras ("Ana" conta; "de", "da" não).
  const nameParts = fold(ctx.fullName ?? '')
    .split(/[^a-z]+/)
    .filter((part) => part.length >= 3);
  if (nameParts.some((part) => p.includes(part))) return 'CONTAINS_NAME';
  const cpf = digits(ctx.taxId ?? '');
  if (cpf.length === 11 && digits(password).includes(cpf)) return 'CONTAINS_TAX_ID';
  return null;
}

export const PASSWORD_MESSAGES: Record<PasswordViolation, string> = {
  TOO_SHORT: `Use pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`,
  TOO_LONG: 'A senha é longa demais.',
  COMMON_PASSWORD: 'Essa senha é muito comum ou já apareceu em vazamentos.',
  CONTAINS_EMAIL: 'A senha não pode conter o seu e-mail.',
  CONTAINS_NAME: 'A senha não pode conter o seu nome.',
  CONTAINS_TAX_ID: 'A senha não pode conter o seu CPF.',
};
