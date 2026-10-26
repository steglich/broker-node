import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
import { BusinessDate, Instant } from '@broker/domain-kernel';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTINES } from '../src/domain/catalog.js';
import {
  decide,
  dueAt,
  nextDueAfter,
  planDate,
  type ExecutionRecord,
  type RoutineDefinition,
} from '../src/domain/routines.js';

const cal = new TradingCalendar(b3Calendar2026To2027);
const d = BusinessDate.parse;
const at = (date: string, hhmm: string) => d(date).atLocalTime(hhmm);
const def = (name: string) => DEFAULT_ROUTINES.find((r) => r.name === name)!;
const done = (names: string[], date: string): ExecutionRecord[] =>
  names.map((routineName) => ({ routineName, businessDate: d(date), status: 'COMPLETED' }));
const names = (list: Array<{ routineName: string }>) => list.map((r) => r.routineName);

describe('quando cada rotina roda (Pregão §8)', () => {
  it('horário fixo é de São Paulo; fase vem da grade do calendário', () => {
    expect(dueAt(def('settlement'), d('2026-03-02'), cal)?.toString()).toBe(
      '2026-03-02T11:00:00.000Z',
    );
    expect(dueAt(def('pre_trading'), d('2026-03-02'), cal)?.toString()).toBe(
      at('2026-03-02', '09:00').toString(),
    );
    expect(dueAt(def('leveraged_day_trade_close'), d('2026-03-02'), cal)?.toString()).toBe(
      at('2026-03-02', '16:25').toString(),
    );
    expect(dueAt(def('daily_close'), d('2026-03-02'), cal)?.toString()).toBe(
      at('2026-03-02', '17:30').toString(),
    );
  });

  it('Quarta-feira de Cinzas (LATE_OPEN): as fases acompanham a grade especial', () => {
    expect(dueAt(def('pre_trading'), d('2026-02-18'), cal)?.toString()).toBe(
      at('2026-02-18', '12:00').toString(),
    );
    expect(dueAt(def('settlement'), d('2026-02-18'), cal)?.toString()).toBe(
      at('2026-02-18', '08:00').toString(),
    );
  });

  it('RN-ROT-001 / spec "Feriado": nenhuma rotina de pregão ou liquidação no feriado nem no fim de semana', () => {
    expect(planDate(DEFAULT_ROUTINES, d('2026-02-16'), cal)).toEqual([]); // Carnaval
    expect(planDate(DEFAULT_ROUTINES, d('2026-12-31'), cal)).toEqual([]); // NO_TRADING
    expect(planDate(DEFAULT_ROUTINES, d('2026-03-07'), cal)).toEqual([]); // sábado
  });

  it('spec "Rotina mensal": no primeiro dia útil do mês, taxa de custódia e IR do mês anterior', () => {
    const monthly = (date: string) =>
      planDate(DEFAULT_ROUTINES, d(date), cal)
        .map((p) => p.definition.name)
        .filter((n) => n === 'custody_fee' || n === 'monthly_tax_assessment');
    expect(monthly('2026-03-02')).toEqual(['custody_fee', 'monthly_tax_assessment']); // 1/3 é domingo
    expect(monthly('2026-03-03')).toEqual([]);
    expect(monthly('2026-01-02')).toEqual(['custody_fee', 'monthly_tax_assessment']); // 1/1 é feriado
  });

  it('rotina desligada não entra no plano', () => {
    const off: RoutineDefinition = { ...def('settlement'), enabled: false };
    expect(dueAt(off, d('2026-03-02'), cal)).toBeNull();
  });
});

describe('decisão de disparo (RN-ROT-001..003)', () => {
  it('dispara só o que já venceu, em ordem de horário', () => {
    const r = decide({
      definitions: DEFAULT_ROUTINES,
      calendar: cal,
      now: at('2026-03-03', '08:40'),
      cursor: d('2026-03-03'),
      executions: [],
    });
    expect(names(r.trigger)).toEqual(['calendar_check', 'settlement', 'corporate_actions_ex_date']);
    expect(r.nextCursor.toString()).toBe('2026-03-03');
  });

  it('RN-ROT-001: o que já tem execução não é disparado de novo', () => {
    const executions: ExecutionRecord[] = [
      { routineName: 'settlement', businessDate: d('2026-03-03'), status: 'TRIGGERED' },
    ];
    const r = decide({
      definitions: DEFAULT_ROUTINES,
      calendar: cal,
      now: at('2026-03-03', '08:40'),
      cursor: d('2026-03-03'),
      executions,
    });
    expect(names(r.trigger)).toEqual(['calendar_check', 'corporate_actions_ex_date']);
  });

  it('RN-ROT-002 / spec "Notas antes do fechamento": as notas esperam o fechamento concluir', () => {
    const before = [
      'calendar_check',
      'settlement',
      'corporate_actions_ex_date',
      'securities_lending_renewal',
      'pre_trading',
      'pre_opening',
      'continuous',
      'leveraged_day_trade_close',
      'closing_call',
    ];
    const executions = [
      ...done(before, '2026-03-03'),
      { routineName: 'post_close', businessDate: d('2026-03-03'), status: 'TRIGGERED' as const },
      { routineName: 'eod_orders', businessDate: d('2026-03-03'), status: 'COMPLETED' as const },
    ];
    const waiting = decide({
      definitions: DEFAULT_ROUTINES,
      calendar: cal,
      now: at('2026-03-03', '17:12'),
      cursor: d('2026-03-03'),
      executions,
    });
    expect(names(waiting.trigger)).toEqual([]);
    expect(waiting.waiting).toContainEqual({
      routineName: 'brokerage_notes',
      businessDate: d('2026-03-03'),
      missing: ['post_close'],
    });

    executions[before.length] = {
      routineName: 'post_close',
      businessDate: d('2026-03-03'),
      status: 'COMPLETED',
    };
    const ready = decide({
      definitions: DEFAULT_ROUTINES,
      calendar: cal,
      now: at('2026-03-03', '17:12'),
      cursor: d('2026-03-03'),
      executions,
    });
    expect(names(ready.trigger)).toEqual(['brokerage_notes']);
  });

  it('RN-ROT-003 / spec "Sistema fora por um dia": as rotinas de D saem antes das de D+1', () => {
    // Fora o dia 03/03 inteiro; volta às 08:30 do dia 04/03.
    const r = decide({
      definitions: DEFAULT_ROUTINES,
      calendar: cal,
      now: at('2026-03-04', '08:30'),
      cursor: d('2026-03-03'),
      executions: [],
    });
    expect(r.trigger.every((t) => t.businessDate.toString() === '2026-03-03')).toBe(true);
    expect(r.trigger.every((t) => t.catchUp)).toBe(true);
    // Independentes de D saem já; o resto de D espera as dependências; D+1 espera D.
    expect(names(r.trigger)).toEqual([
      'calendar_check',
      'settlement',
      'corporate_actions_ex_date',
      'securities_lending_renewal',
      'leveraged_day_trade_close',
      'customer_daily',
      'pix_reconciliation',
      'audit_chain_verify',
    ]);
    expect(r.nextCursor.toString()).toBe('2026-03-03');
  });

  it('RN-ROT-003: com D inteiro disparado, a vez é de D+1 (e o cursor pula o fim de semana)', () => {
    const allOfD = planDate(DEFAULT_ROUTINES, d('2026-03-06'), cal).map((p) => p.definition.name);
    const r = decide({
      definitions: DEFAULT_ROUTINES,
      calendar: cal,
      now: at('2026-03-09', '07:05'),
      cursor: d('2026-03-06'),
      executions: done(allOfD, '2026-03-06'),
    });
    expect(r.trigger.map((t) => `${t.routineName}@${t.businessDate.toString()}`)).toEqual([
      'calendar_check@2026-03-09',
    ]);
    expect(r.nextCursor.toString()).toBe('2026-03-09');
  });

  it('nextDueAfter encontra o próximo horário de rotina dentro do intervalo', () => {
    const after = at('2026-03-03', '08:00');
    expect(
      nextDueAfter({
        definitions: DEFAULT_ROUTINES,
        calendar: cal,
        after,
        until: at('2026-03-03', '23:59'),
      })?.toString(),
    ).toBe(at('2026-03-03', '08:30').toString());
    expect(
      nextDueAfter({
        definitions: DEFAULT_ROUTINES,
        calendar: cal,
        after,
        until: at('2026-03-03', '08:15'),
      }),
    ).toBeNull();
    expect(Instant.parse('2026-03-03T11:00:00Z').equals(at('2026-03-03', '08:00'))).toBe(true);
  });
});
