/** Status da conta (Contas §7.2). */
export type AccountStatus = 'ACTIVE' | 'RESTRICTED' | 'BLOCKED' | 'CLOSING' | 'CLOSED';

/** Motivos de restrição parcial: a conta fica `RESTRICTED` enquanto houver algum. */
export type Restriction = 'NEGATIVE_BALANCE' | 'REGISTRATION_EXPIRED';

export type Operation = 'BUY' | 'SELL' | 'DEPOSIT' | 'WITHDRAW' | 'LOGIN';

/**
 * Matriz de permissões (Contas §7.2). `SELL` em `RESTRICTED` é só para reduzir posição e `WITHDRAW`
 * só sem saldo devedor: o detalhe fica com o OMS e o ledger, que conhecem posição e saldo.
 */
const MATRIX: Record<AccountStatus, Record<Operation, boolean>> = {
  ACTIVE: { BUY: true, SELL: true, DEPOSIT: true, WITHDRAW: true, LOGIN: true },
  RESTRICTED: { BUY: false, SELL: true, DEPOSIT: true, WITHDRAW: true, LOGIN: true },
  BLOCKED: { BUY: false, SELL: false, DEPOSIT: false, WITHDRAW: false, LOGIN: true },
  CLOSING: { BUY: false, SELL: true, DEPOSIT: false, WITHDRAW: true, LOGIN: true },
  CLOSED: { BUY: false, SELL: false, DEPOSIT: false, WITHDRAW: false, LOGIN: true },
};

export function permissions(
  status: AccountStatus,
  restrictions: readonly Restriction[],
): Record<Operation, boolean> {
  const p = { ...MATRIX[status] };
  // Com saldo devedor, a restrita não saca (Contas §7.2).
  if (status === 'RESTRICTED' && restrictions.includes('NEGATIVE_BALANCE')) p.WITHDRAW = false;
  return p;
}

/**
 * Status depois de mudar as restrições: `ACTIVE` ↔ `RESTRICTED` segue a lista; `BLOCKED`,
 * `CLOSING` e `CLOSED` não mudam por restrição (o bloqueio total prevalece).
 */
export function statusFor(
  current: AccountStatus,
  restrictions: readonly Restriction[],
): AccountStatus {
  if (current !== 'ACTIVE' && current !== 'RESTRICTED') return current;
  return restrictions.length > 0 ? 'RESTRICTED' : 'ACTIVE';
}

/** Transições manuais permitidas (Contas §7.2). */
const TRANSITIONS: Record<AccountStatus, readonly AccountStatus[]> = {
  ACTIVE: ['RESTRICTED', 'BLOCKED', 'CLOSING'],
  RESTRICTED: ['ACTIVE', 'BLOCKED'],
  BLOCKED: ['ACTIVE', 'RESTRICTED'],
  CLOSING: ['CLOSED', 'ACTIVE'],
  CLOSED: [],
};
export const canTransition = (from: AccountStatus, to: AccountStatus) =>
  TRANSITIONS[from].includes(to);

/** Dígito verificador módulo 11 do número da conta (pesos 2..8 da direita para a esquerda). */
export function accountCheckDigit(base: string): number {
  let sum = 0;
  for (let i = 0; i < base.length; i++) sum += Number(base[base.length - 1 - i]) * (2 + (i % 7));
  const dv = 11 - (sum % 11);
  return dv >= 10 ? 0 : dv;
}

/** RN-ACC-001: `NNNNNNN-D` a partir do sequencial. */
export function accountNumber(seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 9_999_999)
    throw new Error(`sequencial fora da faixa: ${seq}`);
  const base = String(seq).padStart(7, '0');
  return `${base}-${accountCheckDigit(base)}`;
}

export const isValidAccountNumber = (n: string): boolean => {
  const m = /^(\d{7})-(\d)$/.exec(n);
  return !!m && accountCheckDigit(m[1]!) === Number(m[2]);
};

/** Pendência que impede o encerramento (RN-ACC-012). */
export interface ClosurePendency {
  source: 'LEDGER' | 'CUSTODY' | 'SECURITIES_LENDING' | 'CLEARING' | 'TAX';
  code: string;
  message: string;
}

/** Conta de saque (RN-ACC-020/021). */
export const MAX_WITHDRAWAL_ACCOUNTS = 3;
export const WITHDRAWAL_ACCOUNT_GRACE_MS = 24 * 3_600_000;
/** RN-CAD-003: o cadastro vale 24 meses. */
export const REGISTRATION_VALIDITY_MONTHS = 24;
