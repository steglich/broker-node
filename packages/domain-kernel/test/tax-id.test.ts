import { describe, expect, it } from 'vitest';
import { DomainError, TaxId } from '../src/index.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as DomainError).code;
  }
  return undefined;
};

describe('TaxId (RN-ONB §4.1)', () => {
  it('aceita CPF válido com e sem máscara', () => {
    expect(TaxId.parse('52998224725').formatted()).toBe('529.982.247-25');
    expect(TaxId.parse('529.982.247-25').digits).toBe('52998224725');
  });

  it('TAX_ID_INVALID: dígito verificador errado', () => {
    expect(code(() => TaxId.parse('52998224726'))).toBe('TAX_ID_INVALID');
    expect(code(() => TaxId.parse('52998224715'))).toBe('TAX_ID_INVALID');
  });

  it('TAX_ID_INVALID: sequências repetidas, inclusive as que passam no módulo 11', () => {
    for (let d = 0; d <= 9; d++) {
      expect(code(() => TaxId.parse(String(d).repeat(11)))).toBe('TAX_ID_INVALID');
    }
  });

  it('TAX_ID_INVALID: tamanho e formato errados', () => {
    for (const bad of [
      '',
      '5299822472',
      '529982247250',
      '529.982.24725',
      'abcdefghijk',
      '529 982 247 25',
    ]) {
      expect(code(() => TaxId.parse(bad))).toBe('TAX_ID_INVALID');
    }
    expect(code(() => TaxId.parse(52998224725 as unknown as string))).toBe('TAX_ID_INVALID');
  });

  it('LGPD: mascarado como ***.456.789-** e nunca vaza em toString/JSON', () => {
    const cpf = TaxId.parse('52998224725');
    expect(cpf.masked()).toBe('***.982.247-**');
    expect(`${cpf}`).toBe('***.982.247-**');
    expect(JSON.stringify({ cpf })).toBe('{"cpf":"***.982.247-**"}');
  });
});
