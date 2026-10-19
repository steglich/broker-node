const ACCOUNT_PATTERN = /^(\d{7})-(\d)$/;
export const ACCOUNT_SEQUENCE_MAX = 9_999_999;

/**
 * Dígito verificador da conta (RN-ACC-001): módulo 11 com pesos 2..9 da direita para a esquerda
 * (repetindo); DV = 11 − (soma mod 11), e 10 ou 11 viram 0.
 */
export function accountCheckDigit(digits: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const dv = 11 - (sum % 11);
  return dv >= 10 ? 0 : dv;
}

/** Formata o sequencial no número de conta `NNNNNNN-D` (RN-ACC-001). */
export function formatAccountNumber(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > ACCOUNT_SEQUENCE_MAX) {
    throw new Error(`sequencial de conta fora de 1..${ACCOUNT_SEQUENCE_MAX}: ${sequence}`);
  }
  const digits = String(sequence).padStart(7, '0');
  return `${digits}-${accountCheckDigit(digits)}`;
}

/** Valida formato e DV de um número de conta. */
export function isValidAccountNumber(value: string): boolean {
  const m = ACCOUNT_PATTERN.exec(value);
  return m !== null && Number(m[2]) === accountCheckDigit(m[1]!) && Number(m[1]) >= 1;
}
