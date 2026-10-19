import { DomainError } from './errors.js';

const FORMATTED = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/;
const DIGITS = /^\d{11}$/;

/** Dígito verificador do CPF (módulo 11) para os primeiros `base.length` dígitos. */
export function cpfCheckDigit(base: string): number {
  let sum = 0;
  const firstWeight = base.length + 1;
  for (let i = 0; i < base.length; i++) sum += Number(base[i]) * (firstWeight - i);
  const rest = (sum * 10) % 11;
  return rest === 10 ? 0 : rest;
}

/**
 * CPF validado na construção (RN-ONB §4.1): 11 dígitos, dígitos verificadores válidos (módulo 11)
 * e sem sequência repetida. Fora do titular é exibido mascarado (`***.456.789-**`, inventário LGPD).
 *
 * `toString()` e `toJSON()` devolvem a versão mascarada, para o CPF não vazar em logs por engano.
 */
export class TaxId {
  private constructor(readonly digits: string) {}

  /** Aceita `12345678909` ou `123.456.789-09`. Falha com `TAX_ID_INVALID`. */
  static parse(input: string): TaxId {
    if (typeof input !== 'string' || !(DIGITS.test(input) || FORMATTED.test(input))) {
      throw new DomainError('TAX_ID_INVALID', 'CPF precisa ter 11 dígitos');
    }
    const digits = input.replace(/\D/g, '');
    if (/^(\d)\1{10}$/.test(digits)) {
      throw new DomainError('TAX_ID_INVALID', 'CPF com sequência repetida');
    }
    const dv1 = cpfCheckDigit(digits.slice(0, 9));
    const dv2 = cpfCheckDigit(digits.slice(0, 10));
    if (Number(digits[9]) !== dv1 || Number(digits[10]) !== dv2) {
      throw new DomainError('TAX_ID_INVALID', 'CPF com dígito verificador inválido');
    }
    return new TaxId(digits);
  }

  /** Formato completo, só para o próprio titular: `123.456.789-09`. */
  formatted(): string {
    const d = this.digits;
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }

  /** Formato mascarado: `***.456.789-**`. */
  masked(): string {
    const d = this.digits;
    return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  }

  equals(other: TaxId): boolean {
    return this.digits === other.digits;
  }

  toString(): string {
    return this.masked();
  }

  toJSON(): string {
    return this.masked();
  }
}
