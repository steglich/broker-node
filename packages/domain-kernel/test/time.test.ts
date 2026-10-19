import { describe, expect, it } from 'vitest';
import { BusinessDate, DomainError, Instant } from '../src/index.js';

describe('Instant e BusinessDate (P-02)', () => {
  it('P-02: 2026-10-17T01:30:00Z é a data de negócio 2026-10-16 em São Paulo', () => {
    expect(Instant.parse('2026-10-17T01:30:00Z').businessDate().toString()).toBe('2026-10-16');
    expect(Instant.parse('2026-10-17T02:59:59.999Z').businessDate().toString()).toBe('2026-10-16');
    expect(Instant.parse('2026-10-17T03:00:00Z').businessDate().toString()).toBe('2026-10-17');
  });

  it('P-02: instante só em ISO 8601 UTC com Z', () => {
    expect(Instant.parse('2026-10-16T20:00:00Z').toString()).toBe('2026-10-16T20:00:00.000Z');
    expect(() => Instant.parse('2026-10-16T17:00:00-03:00')).toThrow(DomainError);
    expect(() => Instant.parse('2026-10-16 20:00')).toThrow(DomainError);
  });

  it('data de negócio: parse, dia da semana, aritmética e datas inexistentes', () => {
    const d = BusinessDate.parse('2026-02-13');
    expect(d.isoWeekday()).toBe(5);
    expect(d.plusDays(1).isWeekend()).toBe(true);
    expect(d.plusDays(5).toString()).toBe('2026-02-18');
    expect(BusinessDate.parse('1969-12-31').isoWeekday()).toBe(3);
    expect(() => BusinessDate.parse('2026-02-30')).toThrow(/inexistente/);
    expect(() => BusinessDate.parse('16/10/2026')).toThrow(DomainError);
  });

  it('P-02: horário local de São Paulo convertido para UTC (UTC−3)', () => {
    expect(BusinessDate.parse('2026-02-18').atLocalTime('13:00').toString()).toBe(
      '2026-02-18T16:00:00.000Z',
    );
    expect(BusinessDate.parse('2026-12-31').atLocalTime('23:30').toString()).toBe(
      '2027-01-01T02:30:00.000Z',
    );
  });
});
