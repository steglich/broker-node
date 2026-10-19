import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DomainError, Money, Percentage, Price, Quantity } from '../src/index.js';
import { decimalString, scaled } from './arbitraries.js';

const brl = (v: string) => Money.of(v, 'BRL');

describe('Money (ADR-0004)', () => {
  it('ADR-0004: 0,10 + 0,20 = 0,30 exatamente', () => {
    expect(brl('0.10').plus(brl('0.20')).equals(brl('0.30'))).toBe(true);
    expect(brl('0.1').plus(brl('0.2')).toString()).toBe('0.30');
  });

  it('ADR-0004: soma e subtração são exatas para quaisquer decimais (propriedade)', () => {
    fc.assert(
      fc.property(decimalString(8), decimalString(8), (a, b) => {
        const sum = Money.of(a, 'BRL').plus(Money.of(b, 'BRL'));
        const diff = Money.of(a, 'BRL').minus(Money.of(b, 'BRL'));
        expect(scaled(sum.amount.toFixed(8), 8)).toBe(scaled(a, 8) + scaled(b, 8));
        expect(scaled(diff.amount.toFixed(8), 8)).toBe(scaled(a, 8) - scaled(b, 8));
      }),
    );
  });

  it('ADR-0004: construir a partir de number é recusado', () => {
    expect(() => Money.of(0.1 as unknown as string, 'BRL')).toThrow(DomainError);
    expect(() => Money.of(0.1 as unknown as string, 'BRL')).toThrow(/ponto flutuante/);
    fc.assert(
      fc.property(fc.double(), (n) => {
        expect(() => Money.of(n as unknown as string, 'BRL')).toThrow(DomainError);
      }),
    );
  });

  it('ADR-0004: aceita string decimal e inteiro na menor unidade', () => {
    expect(Money.fromMinor(10n, 'BRL').equals(brl('0.10'))).toBe(true);
    expect(brl('3851.15').toMinor()).toBe(385115n);
    expect(() => Money.fromMinor(10 as unknown as bigint, 'BRL')).toThrow(DomainError);
    expect(() => brl('1e3')).toThrow(DomainError);
    expect(() => brl('1,50')).toThrow(DomainError);
  });

  it('P-01: operações entre moedas diferentes falham com erro de domínio', () => {
    expect(() => brl('1.00').plus(Money.of('1.00', 'USD'))).toThrow(
      /CURRENCY_MISMATCH|moedas diferentes/,
    );
    try {
      brl('1.00').minus(Money.of('1.00', 'USD'));
    } catch (e) {
      expect((e as DomainError).code).toBe('CURRENCY_MISMATCH');
    }
    expect(() => Money.of('1.00', 'real')).toThrow(DomainError);
  });

  it('RN-FEE-030: HALF_UP de emolumentos 0,1925 → 0,19', () => {
    expect(brl('0.1925').round('HALF_UP').toString()).toBe('0.19');
    expect(brl('0.195').round('HALF_UP').toString()).toBe('0.20');
    expect(brl('-0.195').round('HALF_UP').toString()).toBe('-0.20');
  });

  it('RN-CA-022: truncamento de provento 12,3456 → 12,34', () => {
    expect(brl('12.3456').round('TRUNCATE').toString()).toBe('12.34');
    expect(brl('12.3499').round('TRUNCATE').toString()).toBe('12.34');
  });

  it('ADR-0004: arredondamento direcional (CEIL/FLOOR) e determinístico', () => {
    expect(brl('10.001').round('CEIL').toString()).toBe('10.01');
    expect(brl('10.009').round('FLOOR').toString()).toBe('10.00');
    fc.assert(
      fc.property(decimalString(8), (a) => {
        const m = brl(a);
        for (const mode of ['HALF_UP', 'TRUNCATE', 'CEIL', 'FLOOR'] as const) {
          expect(m.round(mode).equals(m.round(mode))).toBe(true);
          expect(m.round(mode).amount.decimalPlaces()).toBeLessThanOrEqual(2);
        }
        expect(m.round('FLOOR').compare(m)).toBeLessThanOrEqual(0);
        expect(m.round('CEIL').compare(m)).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('ADR-0004: toMinor exige arredondamento explícito antes', () => {
    expect(() => brl('0.105').toMinor()).toThrow(/arredonde antes/);
  });

  it('ADR-0004 §3: serializa como string decimal com a moeda', () => {
    expect(JSON.stringify(brl('3851.1'))).toBe('{"amount":"3851.10","currency":"BRL"}');
  });
});

describe('Price', () => {
  it('ADR-0004: preço de referência com até 8 casas; negociação até 4', () => {
    expect(Price.of('38.51150000').toString()).toBe('38.5115');
    expect(() => Price.of('1.123456789')).toThrow(/8 casas/);
    expect(Price.trading('38.50').toString()).toBe('38.50');
    expect(() => Price.trading('38.12345')).toThrow(/4 casas/);
    expect(() => Price.trading('0')).toThrow(DomainError);
    expect(() => Price.of('-1')).toThrow(DomainError);
    expect(() => Price.of(38.5 as unknown as string)).toThrow(DomainError);
  });

  it('ADR-0004: ajuste ao tick com direção conservadora explícita', () => {
    expect(Price.of('10.123').roundToTick('0.01', 'CEIL').toString()).toBe('10.13');
    expect(Price.of('10.127').roundToTick('0.01', 'FLOOR').toString()).toBe('10.12');
    expect(Price.of('10.125').roundToTick('0.05', 'HALF_UP').toString()).toBe('10.15');
  });
});

describe('Quantity', () => {
  it('RN-ORD: quantidade fracionária 10.5 é recusada na construção', () => {
    expect(() => Quantity.of('10.5')).toThrow(/inteira/);
    expect(() => Quantity.of(10 as unknown as bigint)).toThrow(DomainError);
  });

  it('quantidade de ordem precisa ser maior que zero; posição pode ser negativa', () => {
    expect(Quantity.positive('100').value).toBe(100n);
    expect(() => Quantity.positive(0n)).toThrow(/maior que zero/);
    expect(Quantity.of(-300n).plus(Quantity.of(500n)).toString()).toBe('200');
  });

  it('respeita o limite de 64 bits', () => {
    expect(() => Quantity.of(2n ** 63n)).toThrow(/64 bits/);
    expect(() => Quantity.of(2n ** 63n - 1n).plus(Quantity.of(1n))).toThrow(/64 bits/);
  });
});

describe('Percentage', () => {
  it('ADR-0004: taxa com 8 casas aplicada sem arredondar e arredondada no fim', () => {
    const emolumentos = Percentage.fromPercent('0.005');
    expect(emolumentos.toString()).toBe('0.00005000');
    expect(emolumentos.applyTo(brl('3850.00')).toString()).toBe('0.1925');
    expect(emolumentos.applyTo(brl('3850.00')).round('HALF_UP').toString()).toBe('0.19');
    expect(() => Percentage.fromFraction('0.000000001')).toThrow(/8 casas/);
  });
});
