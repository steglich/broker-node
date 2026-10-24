// Regras puras: etapas, decisão do KYC, número da conta, matriz de status, suitability e documentos.
import { BusinessDate } from '@broker/domain-kernel';
import { describe, expect, it } from 'vitest';
import {
  accountNumber,
  isValidAccountNumber,
  permissions,
  statusFor,
} from '../src/domain/account.js';
import { plusMonths } from '../src/domain/dates.js';
import { checkDocument, MAX_DOCUMENT_BYTES } from '../src/domain/documents.js';
import {
  afterStep,
  decideKyc,
  nextStep,
  normalizeCheck,
  validateBirthDate,
} from '../src/domain/onboarding.js';
import { DEFAULT_QUESTIONNAIRE } from '../src/domain/questionnaire.js';
import { profileFor, score } from '../src/domain/suitability.js';
import { answersFor, png } from './helpers.js';

describe('etapas do onboarding (RN-ONB-001)', () => {
  it('avança uma etapa por vez; refazer uma anterior não volta o progresso; não pula', () => {
    expect(afterStep('STARTED', 'CONTACT_VERIFIED')).toBe('CONTACT_VERIFIED');
    expect(afterStep('FINANCIAL_PROFILE', 'ADDRESS')).toBe('FINANCIAL_PROFILE');
    expect(() => afterStep('CONTACT_VERIFIED', 'ADDRESS')).toThrow();
    expect(nextStep('ADDRESS')).toBe('FINANCIAL_PROFILE');
    expect(nextStep('TERMS')).toBe('SUBMIT');
  });

  it('17 anos na data é UNDERAGE; 121 é inválido', () => {
    const today = BusinessDate.parse('2026-01-05');
    expect(validateBirthDate('2008-01-06', today)?.code).toBe('UNDERAGE');
    expect(validateBirthDate('2008-01-05', today)).toBeNull();
    expect(validateBirthDate('1904-01-01', today)?.code).toBe('INVALID_DATE');
  });
});

describe('decisão do KYC (RN-ONB-010/011/020)', () => {
  it('FACE_MATCH pelo score: ≥ 80 aprova, 50–79 revisão, < 50 reprova', () => {
    expect(normalizeCheck('FACE_MATCH', 'PASSED', 80)).toBe('PASS');
    expect(normalizeCheck('FACE_MATCH', 'PASSED', 79)).toBe('REVIEW');
    expect(normalizeCheck('FACE_MATCH', 'PASSED', 49)).toBe('FAIL');
  });

  it('reprovação reprova; atenção revisa; PEP ou residência fiscal no exterior forçam revisão', () => {
    const none = { pep: false, foreignTaxResidency: false };
    expect(decideKyc(['PASS', 'PASS'], none).outcome).toBe('APPROVED');
    expect(decideKyc(['PASS', 'REVIEW'], none).outcome).toBe('MANUAL_REVIEW');
    expect(decideKyc(['FAIL', 'REVIEW'], none).outcome).toBe('REJECTED');
    expect(decideKyc(['PASS'], { pep: true, foreignTaxResidency: false })).toEqual({
      outcome: 'MANUAL_REVIEW',
      reason: 'PEP',
    });
    expect(decideKyc(['PASS'], { pep: false, foreignTaxResidency: true }).reason).toBe(
      'FOREIGN_TAX_RESIDENCY',
    );
  });
});

describe('conta (RN-ACC-001, Contas §7.2)', () => {
  it('NNNNNNN-D com dígito verificador módulo 11', () => {
    expect(accountNumber(1000001)).toMatch(/^1000001-\d$/);
    for (let i = 1000001; i < 1000100; i++)
      expect(isValidAccountNumber(accountNumber(i))).toBe(true);
    const n = accountNumber(1000001);
    expect(isValidAccountNumber(`${n.slice(0, 8)}${(Number(n[8]) + 1) % 10}`)).toBe(false);
  });

  it('matriz: restrita não compra; com saldo devedor, não saca; bloqueada só loga', () => {
    expect(permissions('RESTRICTED', []).BUY).toBe(false);
    expect(permissions('RESTRICTED', []).SELL).toBe(true);
    expect(permissions('RESTRICTED', ['NEGATIVE_BALANCE']).WITHDRAW).toBe(false);
    expect(permissions('BLOCKED', [])).toEqual({
      BUY: false,
      SELL: false,
      DEPOSIT: false,
      WITHDRAW: false,
      LOGIN: true,
    });
    expect(statusFor('ACTIVE', ['NEGATIVE_BALANCE'])).toBe('RESTRICTED');
    expect(statusFor('RESTRICTED', [])).toBe('ACTIVE');
    expect(statusFor('BLOCKED', [])).toBe('BLOCKED');
  });
});

describe('suitability (RN-SUI-003) e documentos', () => {
  it('32 pontos com as faixas padrão é AGGRESSIVE; 16 é MODERATE; 15 é CONSERVATIVE', () => {
    expect(score(DEFAULT_QUESTIONNAIRE, answersFor(32))).toBe(32);
    expect(profileFor(DEFAULT_QUESTIONNAIRE, 32)).toBe('AGGRESSIVE');
    expect(profileFor(DEFAULT_QUESTIONNAIRE, 16)).toBe('MODERATE');
    expect(profileFor(DEFAULT_QUESTIONNAIRE, 15)).toBe('CONSERVATIVE');
    expect(() => score(DEFAULT_QUESTIONNAIRE, { objective: 'a' })).toThrow(/Responda/);
  });

  it('validade de 24 meses no calendário (29/02 vira 28/02)', () => {
    expect(plusMonths(BusinessDate.parse('2026-01-05'), 24).toString()).toBe('2028-01-05');
    expect(plusMonths(BusinessDate.parse('2028-02-29'), 24).toString()).toBe('2030-02-28');
  });

  it('documento: tipo pelos bytes, até 10 MB e no mínimo 800×600', () => {
    expect(checkDocument(4096, png(1200, 900))).toMatchObject({ format: 'PNG', width: 1200 });
    expect(checkDocument(12 * 1024 * 1024, png(1200, 900))).toBe('TOO_LARGE');
    expect(checkDocument(MAX_DOCUMENT_BYTES, png(640, 480))).toBe('LOW_RESOLUTION');
    expect(checkDocument(10, new TextEncoder().encode('não é imagem'))).toBe('UNSUPPORTED_FORMAT');
    expect(checkDocument(10, new TextEncoder().encode('%PDF-1.7 ...'))).toEqual({ format: 'PDF' });
  });
});
