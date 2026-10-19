import { describe, expect, it } from 'vitest';
import {
  BusinessDate,
  Decimal,
  DomainError,
  Instant,
  Money,
  Percentage,
  Price,
  Quantity,
  toDecimal,
} from '../src/index.js';

const brl = (v: string) => Money.of(v, 'BRL');

describe('comparação, sinal e serialização dos objetos de valor', () => {
  it('Money: compara, nega e detecta zero e negativo', () => {
    expect(brl('1.00').compare(brl('2.00'))).toBe(-1);
    expect(brl('2.00').compare(brl('2.0'))).toBe(0);
    expect(brl('1.50').negated().toString()).toBe('-1.50');
    expect(brl('-0.01').isNegative()).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isNegative()).toBe(false);
    expect(brl('1.00').equals(Money.of('1.00', 'USD'))).toBe(false);
    expect(() => brl('1.00').compare(Money.of('1.00', 'USD'))).toThrow(DomainError);
  });

  it('Money: preserva casas intermediárias e só arredonda quando pedido (ADR-0004)', () => {
    const m = brl('100.00').times('0.00005');
    expect(m.toString()).toBe('0.005');
    expect(m.round('HALF_UP', 8).toString()).toBe('0.005');
    expect(m.round('HALF_UP').toString()).toBe('0.01');
  });

  it('Price: compara, arredonda e serializa como string', () => {
    expect(Price.of('10.10').compare(Price.of('10.2'))).toBe(-1);
    expect(Price.of('10.10').equals(Price.of('10.1'))).toBe(true);
    expect(Price.of('38.51151234').round(4, 'HALF_UP').toString()).toBe('38.5115');
    expect(JSON.stringify({ p: Price.of('7') })).toBe('{"p":"7.00"}');
    expect(() => Price.of('10.00').roundToTick('0', 'CEIL')).toThrow(/tick/);
  });

  it('Quantity: soma, subtrai, compara e serializa como string', () => {
    const q = Quantity.of('300');
    expect(q.minus(Quantity.of(500n)).value).toBe(-200n);
    expect(q.compare(Quantity.zero())).toBe(1);
    expect(Quantity.zero().compare(q)).toBe(-1);
    expect(q.compare(Quantity.of(300n))).toBe(0);
    expect(q.equals(Quantity.of(300n))).toBe(true);
    expect(JSON.stringify({ q: Quantity.of(2n ** 62n) })).toBe(`{"q":"${2n ** 62n}"}`);
  });

  it('Percentage: percentual, igualdade e serialização com 8 casas', () => {
    const p = Percentage.fromPercent('15');
    expect(p.asPercent().toString()).toBe('15');
    expect(p.equals(Percentage.fromFraction('0.15'))).toBe(true);
    expect(JSON.stringify({ p })).toBe('{"p":"0.15000000"}');
  });

  it('Decimal: recusa entradas que não são decimais', () => {
    expect(toDecimal(new Decimal('1.5')).toString()).toBe('1.5');
    expect(toDecimal(15n).toString()).toBe('15');
    expect(() => toDecimal(null as unknown as string)).toThrow(DomainError);
    expect(() => toDecimal('NaN')).toThrow(DomainError);
  });

  it('Instant: comparações, aritmética e validação', () => {
    const a = Instant.parse('2026-10-16T20:00:00Z');
    const b = a.plusMillis(1);
    expect(a.isBefore(b) && b.isAfter(a)).toBe(true);
    expect(a.equals(Instant.ofEpochMillis(a.epochMillis))).toBe(true);
    expect(JSON.stringify({ a })).toBe('{"a":"2026-10-16T20:00:00.000Z"}');
    expect(() => Instant.ofEpochMillis(1.5)).toThrow(DomainError);
    expect(() => Instant.parse('2026-13-45T00:00:00Z')).toThrow(DomainError);
  });

  it('BusinessDate: comparações, ano, serialização e horário inválido', () => {
    const a = BusinessDate.parse('2026-12-31');
    const b = a.plusDays(1);
    expect(b.year()).toBe(2027);
    expect(a.compare(b)).toBe(-1);
    expect(b.compare(a)).toBe(1);
    expect(a.compare(BusinessDate.parse('2026-12-31'))).toBe(0);
    expect(a.isBefore(b) && b.isAfter(a) && a.equals(BusinessDate.parse('2026-12-31'))).toBe(true);
    expect(JSON.stringify({ a })).toBe('{"a":"2026-12-31"}');
    expect(() => BusinessDate.ofEpochDay(0.5)).toThrow(DomainError);
    expect(() => a.atLocalTime('9:00')).toThrow(DomainError);
  });
});
