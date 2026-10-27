import { BusinessDate } from '@broker/domain-kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  b3Calendar2026To2027,
  CalendarNotLoadedError,
  TradingCalendar,
  type CalendarData,
} from '../src/index.js';

const cal = new TradingCalendar(b3Calendar2026To2027);
const d = (iso: string) => BusinessDate.parse(iso);

/** Páscoa (algoritmo de Meeus/Jones/Butcher), para conferir as datas móveis da semente. */
function easter(year: number): BusinessDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const dd = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - dd - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return d(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
}

describe('CAL-001: next_business_day com Carnaval, Corpus Christi e fim de ano', () => {
  it('CAL-001: da sexta antes do Carnaval, D+1 é a Quarta-feira de Cinzas (LATE_OPEN)', () => {
    const next = cal.nextBusinessDay(d('2026-02-13'), 1);
    expect(next.toString()).toBe('2026-02-18');
    expect(cal.dayType(next)).toBe('LATE_OPEN');
    expect(cal.nextBusinessDay(d('2027-02-05'), 1).toString()).toBe('2027-02-10');
  });

  it('CAL-001: Corpus Christi é pulado (quinta → sexta)', () => {
    expect(cal.nextBusinessDay(d('2026-06-03'), 1).toString()).toBe('2026-06-05');
    expect(cal.nextBusinessDay(d('2027-05-26'), 1).toString()).toBe('2027-05-28');
  });

  it('CAL-001: fim de ano com 31/12 NO_TRADING vai para o primeiro dia útil de janeiro', () => {
    expect(cal.dayType(d('2026-12-31'))).toBe('NO_TRADING');
    // 31/12 sem pregão, 1/1 feriado (sexta), 2 e 3/1 fim de semana → segunda, 4/1/2027.
    expect(cal.nextBusinessDay(d('2026-12-30'), 1).toString()).toBe('2027-01-04');
    expect(cal.nextBusinessDay(d('2026-12-23'), 1).toString()).toBe('2026-12-28');
  });

  it('RN-CAL-002: D+2 (liquidação) atravessando o Carnaval', () => {
    expect(cal.nextBusinessDay(d('2026-02-12'), 2).toString()).toBe('2026-02-18');
    expect(cal.previousBusinessDay(d('2026-02-18'), 1).toString()).toBe('2026-02-13');
    expect(cal.previousBusinessDay(d('2027-01-04'), 1).toString()).toBe('2026-12-30');
  });
});

describe('semente B3 2026–2027', () => {
  it.each([2026, 2027])('datas móveis de %i batem com o cálculo da Páscoa', (year) => {
    const e = easter(year);
    expect(cal.dayType(e.plusDays(-48))).toBe('HOLIDAY'); // Carnaval segunda
    expect(cal.dayType(e.plusDays(-47))).toBe('HOLIDAY'); // Carnaval terça
    expect(cal.dayType(e.plusDays(-46))).toBe('LATE_OPEN'); // Cinzas
    expect(cal.dayType(e.plusDays(-2))).toBe('HOLIDAY'); // Sexta-feira Santa
    expect(cal.dayType(e.plusDays(60))).toBe('HOLIDAY'); // Corpus Christi
    expect(e.plusDays(-48).isoWeekday()).toBe(1);
    expect(e.plusDays(60).isoWeekday()).toBe(4);
  });

  it.each([2026, 2027])(
    'feriados fixos de %i que caem em dia de semana estão cadastrados',
    (year) => {
      const fixed = [
        '01-01',
        '04-21',
        '05-01',
        '09-07',
        '10-12',
        '11-02',
        '11-15',
        '11-20',
        '12-25',
      ];
      for (const md of fixed) {
        const date = d(`${year}-${md}`);
        expect(cal.dayType(date)).toBe(date.isWeekend() ? 'WEEKEND' : 'HOLIDAY');
      }
      expect(cal.dayType(d(`${year}-12-24`))).toBe('NO_TRADING');
    },
  );

  it('cobre o ano corrente e o seguinte (RN-CAL-001) e recusa fora do período', () => {
    expect(cal.coverageEnd().toString()).toBe('2027-12-31');
    expect(() => cal.isBusinessDay(d('2028-01-03'))).toThrow(CalendarNotLoadedError);
    expect(() => cal.nextBusinessDay(d('2027-12-30'), 1)).toThrow(/não carregado/);
  });
});

describe('funções de calendário (RN-CAL-002)', () => {
  it('is_business_day: útil, LATE_OPEN sim; feriado, NO_TRADING e fim de semana não', () => {
    expect(cal.isBusinessDay(d('2026-10-16'))).toBe(true);
    expect(cal.isBusinessDay(d('2026-02-18'))).toBe(true);
    expect(cal.isBusinessDay(d('2026-02-17'))).toBe(false);
    expect(cal.isBusinessDay(d('2026-12-24'))).toBe(false);
    expect(cal.isBusinessDay(d('2026-10-17'))).toBe(false);
  });

  it('business_days_between conta (a, b] e é coerente com next/previous (propriedade)', () => {
    expect(cal.businessDaysBetween(d('2026-02-13'), d('2026-02-18'))).toBe(1);
    expect(cal.businessDaysBetween(d('2026-02-18'), d('2026-02-13'))).toBe(-1);
    expect(cal.businessDaysBetween(d('2026-10-16'), d('2026-10-16'))).toBe(0);
    const start = d('2026-01-01').epochDay;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 1, max: 40 }),
        (offset, n) => {
          const from = BusinessDate.ofEpochDay(start + offset);
          const next = cal.nextBusinessDay(from, n);
          expect(cal.isBusinessDay(next)).toBe(true);
          expect(cal.businessDaysBetween(from, next)).toBe(n);
          if (cal.isBusinessDay(from))
            expect(cal.previousBusinessDay(next, n).equals(from)).toBe(true);
        },
      ),
    );
  });

  it('recusa n inválido', () => {
    expect(() => cal.nextBusinessDay(d('2026-10-16'), 0)).toThrow();
    expect(() => cal.previousBusinessDay(d('2026-10-16'), 1.5)).toThrow();
  });
});

describe('session_schedule com vigência (RN-CAL-003)', () => {
  it('grade padrão: contínua das 10:00 às 16:55 BRT (13:00–19:55 UTC)', () => {
    const s = cal.sessionSchedule(d('2026-10-16'))!;
    expect(s.dayType).toBe('BUSINESS_DAY');
    expect(s.phases.map((p) => p.phase)).toEqual([
      'PRE_TRADING',
      'PRE_OPENING',
      'CONTINUOUS',
      'CLOSING_CALL',
      'POST_CLOSE',
    ]);
    const continuous = s.phases.find((p) => p.phase === 'CONTINUOUS')!;
    expect(continuous.startsAt.toString()).toBe('2026-10-16T13:00:00.000Z');
    expect(continuous.endsAt.toString()).toBe('2026-10-16T19:55:00.000Z');
    expect(s.phases.at(-1)!.endsAt.toString()).toBe('2026-10-16T20:30:00.000Z');
  });

  it('LATE_OPEN: Quarta-feira de Cinzas com contínua a partir das 13:00 BRT', () => {
    const s = cal.sessionSchedule(d('2026-02-18'))!;
    expect(s.dayType).toBe('LATE_OPEN');
    expect(s.phases.find((p) => p.phase === 'CONTINUOUS')!.startsAt.toString()).toBe(
      '2026-02-18T16:00:00.000Z',
    );
  });

  it('sem pregão em feriado, NO_TRADING e fim de semana', () => {
    expect(cal.sessionSchedule(d('2026-02-17'))).toBeNull();
    expect(cal.sessionSchedule(d('2026-12-31'))).toBeNull();
    expect(cal.sessionSchedule(d('2026-10-17'))).toBeNull();
  });

  it('RN-CAL-003: escolhe a grade pela vigência da data', () => {
    const base = b3Calendar2026To2027;
    const regular = base.schedules.find((s) => s.dayType === 'BUSINESS_DAY')!;
    const shifted = regular.phases.map((p) =>
      p.phase === 'CONTINUOUS' ? { ...p, start: '11:00' } : p,
    );
    const data: CalendarData = {
      ...base,
      schedules: [
        { ...regular, validTo: '2026-03-06' },
        { ...regular, validFrom: '2026-03-09', validTo: '2026-10-30', phases: shifted },
        { ...regular, validFrom: '2026-11-02' },
        ...base.schedules.filter((s) => s.dayType === 'LATE_OPEN'),
      ],
    };
    const c = new TradingCalendar(data);
    const cont = (iso: string) =>
      c
        .sessionSchedule(d(iso))!
        .phases.find((p) => p.phase === 'CONTINUOUS')!
        .startsAt.toString();
    expect(cont('2026-03-06')).toBe('2026-03-06T13:00:00.000Z');
    expect(cont('2026-03-09')).toBe('2026-03-09T14:00:00.000Z');
    expect(cont('2026-10-30')).toBe('2026-10-30T14:00:00.000Z');
    expect(cont('2026-11-03')).toBe('2026-11-03T13:00:00.000Z');
  });

  it('valida os dados: sem dia repetido nem dia especial no fim de semana', () => {
    const base = b3Calendar2026To2027;
    expect(() => new TradingCalendar({ ...base, days: [...base.days, base.days[0]!] })).toThrow(
      /repetido/,
    );
    expect(
      () =>
        new TradingCalendar({
          ...base,
          days: [{ date: '2026-10-17', type: 'HOLIDAY', description: 'x' }],
        }),
    ).toThrow(/fim de semana/);
  });
});

describe('sandbox sempre útil (RN-SBX-002)', () => {
  const sandbox = new TradingCalendar({ ...b3Calendar2026To2027, allDaysBusiness: true });

  it('RN-SBX-002: sábado, feriado e NO_TRADING são úteis, com a grade BUSINESS_DAY', () => {
    for (const day of ['2026-01-03', '2026-02-16', '2026-12-31']) {
      expect(sandbox.isBusinessDay(d(day))).toBe(true);
      expect(sandbox.dayType(d(day))).toBe('BUSINESS_DAY');
      expect(sandbox.sessionSchedule(d(day))?.phases[2]?.phase).toBe('CONTINUOUS');
    }
    expect(sandbox.nextBusinessDay(d('2026-01-02'), 1).toString()).toBe('2026-01-03');
    expect(sandbox.businessDaysBetween(d('2026-01-01'), d('2026-01-08'))).toBe(7);
  });

  it('RN-SBX-002: continua recusando fora do período carregado', () => {
    expect(() => sandbox.isBusinessDay(d('2028-01-01'))).toThrow(CalendarNotLoadedError);
  });
});
