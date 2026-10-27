import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
import { BusinessDate, Instant } from '@broker/domain-kernel';
import { describe, expect, it } from 'vitest';
import {
  coverageStatus,
  planCalendarChange,
  planSchedule,
  toCalendarData,
  plainDay,
  type StoredSchedule,
} from '../src/domain/calendar.js';
import { assertCanDecide, isStale, type ChangeRequest } from '../src/domain/change-request.js';
import { ReferenceRuleError } from '../src/domain/errors.js';
import {
  applyAttributes,
  changeStatus,
  createInstrument,
  inferType,
  matchFor,
  oddLotSymbol,
  SEED_TYPE_DEFAULTS,
  type AssetType,
} from '../src/domain/instrument.js';
import { rename, renameNotice } from '../src/domain/symbol-history.js';
import {
  DEFAULT_TRADING_RULES,
  effectiveRules,
  planNewVersion,
  validateRules,
  type TradingRuleVersion,
} from '../src/domain/trading-rules.js';
import { assertCanInclude, assertCanRemove } from '../src/domain/universe.js';

const now = Instant.parse('2026-01-05T13:00:00Z');
const d = (iso: string) => BusinessDate.parse(iso);
const defaults = (t: AssetType) => SEED_TYPE_DEFAULTS.find((x) => x.assetType === t)!;
const make = (symbol: string, assetType: AssetType) =>
  createInstrument(
    { id: `id-${symbol}`, symbol, assetType, source: 'BRAPI' },
    defaults(assetType),
    now,
  );
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ReferenceRuleError) return err.code;
    throw err;
  }
  return null;
};

describe('instrumento (Ativos §2–§3)', () => {
  it('Padrão de FII: lote 1, sem fracionário e sem venda a descoberto', () => {
    const fii = make('HGLG11', 'REIT');
    expect(fii).toMatchObject({
      lotSize: 1,
      shortSaleEnabled: false,
      taxCategory: 'REIT',
      status: 'PENDING',
      tradable: false,
    });
    expect(oddLotSymbol(fii)).toBeNull();
  });

  it('RN-INS-002: ação com lote 100 tem fracionário symbol + "F"; RN-INS-006: lote 1 não tem', () => {
    const petr = make('PETR4', 'STOCK');
    expect(oddLotSymbol(petr)).toBe('PETR4F');
    expect(matchFor(petr, 'PETR4F')).toEqual({ board: 'ODD_LOT', tradingSymbol: 'PETR4F' });
    expect(matchFor(make('BOVA11', 'ETF'), 'BOVA11F')).toBeNull();
  });

  it('deduz tipo e classe pelo sufixo quando a fonte não informa', () => {
    expect(inferType('PETR4')).toEqual({ assetType: 'STOCK', shareClass: 'PN' });
    expect(inferType('VALE3')).toEqual({ assetType: 'STOCK', shareClass: 'ON' });
    expect(inferType('AAPL34')).toEqual({ assetType: 'BDR', shareClass: 'N/A' });
    expect(inferType('TAEE11')).toEqual({ assetType: 'UNIT', shareClass: 'UNIT' });
  });

  it('sobrescritas por instrumento são validadas e o haircut some sem garantia', () => {
    const petr = make('PETR4', 'STOCK');
    expect(applyAttributes(petr, { collateralEligible: false }, now).haircut).toBeNull();
    expect(code(() => applyAttributes(petr, { lotSize: 0 }, now))).toBe('INVALID_LOT_SIZE');
    expect(code(() => applyAttributes(petr, { tickSize: '0' }, now))).toBe('INVALID_TICK_SIZE');
    expect(code(() => applyAttributes({ ...petr, tradable: true }, { lotSize: 10 }, now))).toBe(
      'LOT_SIZE_LOCKED_WHILE_TRADABLE',
    );
    expect(code(() => make('PETR', 'STOCK'))).toBe('INVALID_SYMBOL');
  });

  it('Ativos §5: DELISTED é final; transições inválidas recusadas', () => {
    const petr = make('PETR4', 'STOCK');
    const delisted = changeStatus(petr, 'DELISTED', 'X', now);
    expect(code(() => changeStatus(delisted, 'ACTIVE', 'X', now))).toBe(
      'INVALID_STATUS_TRANSITION',
    );
    expect(changeStatus(petr, 'PENDING', 'X', now)).toBe(petr);
  });
});

describe('universo negociável (RN-INS-011..013)', () => {
  it('RN-INS-011: recusa o 21º com o limite padrão, avisando do orçamento da brapi', () => {
    const wege = make('WEGE3', 'STOCK');
    expect(() => assertCanInclude(wege, 19, 20)).not.toThrow();
    expect(code(() => assertCanInclude(wege, 20, 20))).toBe('TRADABLE_UNIVERSE_FULL');
    expect(() => assertCanInclude(wege, 20, 20)).toThrow(/brapi/);
  });

  it('não inclui o que já é negociável ou está deslistado; não retira o que não é negociável', () => {
    const petr = make('PETR4', 'STOCK');
    expect(code(() => assertCanInclude({ ...petr, tradable: true }, 0, 20))).toBe(
      'ALREADY_TRADABLE',
    );
    expect(code(() => assertCanInclude({ ...petr, status: 'DELISTED' }, 0, 20))).toBe(
      'INSTRUMENT_DELISTED',
    );
    expect(code(() => assertCanRemove(petr, 0))).toBe('NOT_TRADABLE');
  });

  it('RN-INS-013: recusa a retirada com ordens abertas', () => {
    const petr = { ...make('PETR4', 'STOCK'), tradable: true };
    expect(code(() => assertCanRemove(petr, 3))).toBe('INSTRUMENT_HAS_OPEN_ORDERS');
    expect(() => assertCanRemove(petr, 0)).not.toThrow();
  });
});

describe('renomeação (RN-INS-030..032)', () => {
  it('mantém o id, guarda o ticker antigo com vigência e formata o aviso', () => {
    const i = make('ELET3', 'STOCK');
    const { instrument, history } = rename(
      i,
      { newSymbol: 'AXIA3', effectiveDate: d('2026-03-02'), currentSince: d('2026-01-05') },
      now,
    );
    expect(instrument).toMatchObject({ id: i.id, symbol: 'AXIA3' });
    expect(history).toMatchObject({
      symbol: 'ELET3',
      validFrom: d('2026-01-05'),
      validTo: d('2026-03-01'),
    });
    expect(renameNotice('ELET3', 'AXIA3', d('2026-03-02'))).toBe(
      'Ticker alterado de ELET3 para AXIA3 em 02/03/2026',
    );
  });

  it('recusa o mesmo ticker, data que não anda para frente e instrumento deslistado', () => {
    const i = make('ELET3', 'STOCK');
    const base = { effectiveDate: d('2026-03-02'), currentSince: d('2026-01-05') };
    expect(code(() => rename(i, { ...base, newSymbol: 'ELET3' }, now))).toBe('SAME_SYMBOL');
    expect(
      code(() => rename(i, { ...base, newSymbol: 'AXIA3', effectiveDate: d('2026-01-05') }, now)),
    ).toBe('INVALID_EFFECTIVE_DATE');
    expect(
      code(() => rename({ ...i, status: 'DELISTED' }, { ...base, newSymbol: 'AXIA3' }, now)),
    ).toBe('INSTRUMENT_DELISTED');
  });

  it('RN-INS-031: conversão com razão ≠ 1 é evento corporativo', () => {
    const i = make('ELET3', 'STOCK');
    expect(
      code(() =>
        rename(
          i,
          {
            newSymbol: 'AXIA3',
            effectiveDate: d('2026-03-02'),
            currentSince: d('2026-01-05'),
            conversionRatio: '2',
          },
          now,
        ),
      ),
    ).toBe('CONVERSION_IS_CORPORATE_ACTION');
  });
});

describe('regras de negociação com vigência (Ativos §7)', () => {
  const global: TradingRuleVersion = {
    id: 'g1',
    instrumentId: null,
    values: DEFAULT_TRADING_RULES,
    validFrom: Instant.parse('2026-01-01T00:00:00Z'),
    validTo: Instant.parse('2026-01-06T03:00:00Z'),
    approvalRequestId: 'seed',
  };
  const next: TradingRuleVersion = {
    ...global,
    id: 'g2',
    values: { ...DEFAULT_TRADING_RULES, rejectionBandPct: '0.15' },
    validFrom: Instant.parse('2026-01-06T03:00:00Z'),
    validTo: null,
  };

  it('Nova vigência: hoje vale o túnel anterior e amanhã o novo', () => {
    expect(effectiveRules([next, global], [], now).values.rejectionBandPct).toBe('0.20');
    expect(
      effectiveRules([next, global], [], Instant.parse('2026-01-06T13:00:00Z')).values
        .rejectionBandPct,
    ).toBe('0.15');
  });

  it('a sobrescrita do instrumento vale sobre o global só nos campos dela', () => {
    const override: TradingRuleVersion = {
      ...global,
      id: 'o1',
      instrumentId: 'i1',
      values: { maxOrderQuantity: 500 },
      validTo: null,
    };
    const e = effectiveRules([global], [override], now);
    expect(e.values).toMatchObject({ maxOrderQuantity: 500, rejectionBandPct: '0.20' });
    expect(e.overridden).toEqual(['maxOrderQuantity']);
  });

  it('valida campos, coerência dos túneis e o encaixe da vigência', () => {
    expect(
      code(() => validateRules({ rejectionBandPct: '0.05' }, 'INSTRUMENT', DEFAULT_TRADING_RULES)),
    ).toBe('INVALID_TRADING_RULES');
    expect(
      code(() => validateRules({ rejectionBandPct: '0.30' }, 'GLOBAL', DEFAULT_TRADING_RULES)),
    ).toBe('INVALID_TRADING_RULES');
    expect(code(() => planNewVersion([next], Instant.parse('2026-01-01T00:00:00Z'), now))).toBe(
      'VALID_FROM_IN_PAST',
    );
    expect(code(() => planNewVersion([next], Instant.parse('2026-01-06T03:00:00Z'), now))).toBe(
      'RULES_VALIDITY_OVERLAP',
    );
    expect(
      planNewVersion([next, global], Instant.parse('2026-01-07T03:00:00Z'), now).close?.id,
    ).toBe('g2');
  });
});

describe('calendário (RN-CAL-001, RN-CAL-003)', () => {
  const range = { from: d('2026-01-01'), to: d('2027-12-31') };

  it('RN-CAL-001: alerta faltando 60 dias para o fim do período carregado', () => {
    expect(coverageStatus(d('2027-11-01'), d('2027-12-31'))).toEqual({ daysLeft: 60, alert: true });
    expect(coverageStatus(d('2027-10-31'), d('2027-12-31')).alert).toBe(false);
  });

  it('estende o período com dias comuns e aplica dias especiais só no futuro e em dias de semana', () => {
    const plan = planCalendarChange(
      range,
      {
        extendTo: '2028-01-07',
        days: [{ date: '2028-01-03', type: 'HOLIDAY', description: 'Teste' }],
      },
      d('2026-01-05'),
    );
    expect(plan.coverageTo.toString()).toBe('2028-01-07');
    expect(plan.rows.find((r) => r.date.toString() === '2028-01-01')?.dayType).toBe('WEEKEND');
    expect(plan.rows.find((r) => r.date.toString() === '2028-01-03')?.dayType).toBe('HOLIDAY');
    expect(
      code(() =>
        planCalendarChange(
          range,
          { days: [{ date: '2026-01-05', type: 'HOLIDAY', description: 'x' }] },
          d('2026-01-05'),
        ),
      ),
    ).toBe('CALENDAR_PAST_DATE');
    expect(
      code(() =>
        planCalendarChange(
          range,
          { days: [{ date: '2026-01-10', type: 'HOLIDAY', description: 'x' }] },
          d('2026-01-05'),
        ),
      ),
    ).toBe('CALENDAR_WEEKEND');
  });

  it('RN-CAL-003: nova grade futura fecha a vigente; fases em ordem e horários crescentes', () => {
    const current: StoredSchedule = {
      id: 's1',
      name: 'Padrão',
      ...b3Calendar2026To2027.schedules[0]!,
    };
    const phases = b3Calendar2026To2027.schedules[0]!.phases.map((p) => ({ ...p }));
    const proposed = {
      name: 'Verão EUA',
      dayType: 'BUSINESS_DAY' as const,
      validFrom: '2026-03-09',
      phases,
    };
    expect(planSchedule([current], proposed, d('2026-01-05')).close?.id).toBe('s1');
    expect(
      code(() =>
        planSchedule([current], { ...proposed, validFrom: '2026-01-05' }, d('2026-01-05')),
      ),
    ).toBe('SCHEDULE_PAST_DATE');
    expect(
      code(() =>
        planSchedule([current], { ...proposed, phases: [...phases].reverse() }, d('2026-01-05')),
      ),
    ).toBe('SCHEDULE_INVALID_PHASES');
  });

  it('RN-SBX-002: os dados publicados levam o modo sandbox para a cópia local', () => {
    const days = [plainDay(d('2026-01-01')), plainDay(d('2026-01-02')), plainDay(d('2026-01-03'))];
    const data = toCalendarData(
      days,
      [{ id: 's', name: 'x', ...b3Calendar2026To2027.schedules[0]! }],
      true,
    );
    expect(new TradingCalendar(data).isBusinessDay(d('2026-01-03'))).toBe(true);
    expect(
      new TradingCalendar({ ...data, allDaysBusiness: false }).isBusinessDay(d('2026-01-03')),
    ).toBe(false);
  });
});

describe('dupla aprovação (Backoffice §4)', () => {
  const r: ChangeRequest = {
    id: 'r1',
    type: 'UNIVERSE_INCLUDE',
    targetId: 'i1',
    payload: {},
    currentState: { tradable: false, status: 'PENDING' },
    justification: 'x',
    makerId: 'maker',
    status: 'PENDING',
    createdAt: now,
    expiresAt: now.plusMillis(24 * 3_600_000),
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
  };

  it('RN-BO-001: o maker não aprova; universo exige BO_ADMIN; vencida não decide', () => {
    expect(code(() => assertCanDecide(r, { id: 'maker', roles: ['BO_ADMIN'] }, now))).toBe(
      'MAKER_CANNOT_APPROVE',
    );
    expect(code(() => assertCanDecide(r, { id: 'outro', roles: ['BO_MARKET'] }, now))).toBe(
      'CHECKER_ROLE_REQUIRED',
    );
    expect(() => assertCanDecide(r, { id: 'admin', roles: ['BO_ADMIN'] }, now)).not.toThrow();
    expect(code(() => assertCanDecide(r, { id: 'admin', roles: ['BO_ADMIN'] }, r.expiresAt))).toBe(
      'REQUEST_EXPIRED',
    );
  });

  it('RN-MC-BO-003: estado diferente (em qualquer ordem de chaves) invalida', () => {
    expect(isStale(r, { status: 'PENDING', tradable: false })).toBe(false);
    expect(isStale(r, { status: 'PENDING', tradable: true })).toBe(true);
  });
});
