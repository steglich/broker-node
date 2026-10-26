// Regras puras: convenção de sinal, journal (soma zero), estorno, saldos, depósito e saque.
import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
import { BusinessDate, Instant, Money } from '@broker/domain-kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeBalances, settlementDays } from '../src/domain/balances.js';
import { customerCash, houseAccount, HOUSE_ACCOUNTS } from '../src/domain/chart.js';
import { decidePayment } from '../src/domain/deposit.js';
import {
  buildJournal,
  LedgerRuleError,
  onNormalSide,
  reversalOf,
  signed,
  type JournalDraft,
  type JournalLine,
} from '../src/domain/journal.js';
import { checkLimits, isNight, nextAttempt, retryDelayMs } from '../src/domain/withdrawal.js';

const brl = (v: string) => Money.of(v, 'BRL');
const D0 = BusinessDate.parse('2026-01-05');
const calendar = new TradingCalendar(b3Calendar2026To2027);

const line = (
  side: 'DEBIT' | 'CREDIT',
  amount: string,
  ownerId: string | null = null,
): JournalLine => ({
  account: ownerId ? customerCash(ownerId) : houseAccount('CLEARING_HOUSE'),
  side,
  amount: brl(amount),
  valueDate: D0,
  status: 'SETTLED',
});

const draft = (lines: JournalLine[]): JournalDraft => ({
  idempotencyKey: 'test:1',
  type: 'ADJUSTMENT',
  referenceType: 'TEST',
  referenceId: '1',
  description: 'teste',
  bookingDate: D0,
  createdBy: 'test',
  lines,
});

/** Valores em centavos → Money (2 casas). */
const cents = fc.bigInt({ min: 1n, max: 10_000_000_00n }).map((c) => Money.fromMinor(c, 'BRL'));

/** Um journal balanceado qualquer: débitos aleatórios e créditos que repartem o mesmo total. */
const balancedLines = fc
  .tuple(fc.array(cents, { minLength: 1, maxLength: 6 }), fc.integer({ min: 1, max: 5 }))
  .map(([debits, nCredits]) => {
    const total = debits.reduce((a, b) => a.plus(b), Money.zero('BRL'));
    const minor = total.toMinor();
    const parts = Array.from({ length: nCredits }, (_, i) =>
      i < nCredits - 1
        ? minor / BigInt(nCredits)
        : minor - (minor / BigInt(nCredits)) * BigInt(nCredits - 1),
    ).filter((p) => p > 0n);
    return [
      ...debits.map((d) => ({ ...line('DEBIT', '1'), amount: d })),
      ...parts.map((p, i) => ({
        ...line('CREDIT', '1', `owner-${i}`),
        amount: Money.fromMinor(p, 'BRL'),
      })),
    ];
  });

describe('convenção de sinal (Financeiro §9) num único lugar', () => {
  it('crédito ao titular é positivo; débito em CUST_CASH diminui o saldo do cliente', () => {
    expect(signed('CREDIT', brl('10.00')).toString()).toBe('10.00');
    expect(signed('DEBIT', brl('10.00')).toString()).toBe('-10.00');
    expect(onNormalSide(brl('-5.00'), 'CREDIT')).toBe(false);
    expect(onNormalSide(brl('-5.00'), 'DEBIT')).toBe(true);
    expect(onNormalSide(Money.zero('BRL'), 'CREDIT')).toBe(true);
  });

  it('RN-LED-011: só SMM_CASH, CLEARING_HOUSE, ISSUER_DISTRIBUTIONS e PAY_*/REV_* aceitam qualquer sinal', () => {
    const anySign = HOUSE_ACCOUNTS.filter((a) => a.anySign).map((a) => a.code);
    expect(
      anySign.every(
        (c) =>
          ['SMM_CASH', 'CLEARING_HOUSE', 'ISSUER_DISTRIBUTIONS'].includes(c) ||
          /^(PAY|REV)_/.test(c),
      ),
    ).toBe(true);
    expect(anySign).not.toContain('HOUSE_PIX_RESERVE');
  });
});

describe('journal de partidas dobradas (RN-LED-001, RN-LED-004, INV-01)', () => {
  it('propriedade: todo journal aceito soma zero', () => {
    fc.assert(
      fc.property(balancedLines, (lines) => {
        const entries = buildJournal(draft(lines));
        const sum = entries.reduce((a, e) => a.plus(e.amount), Money.zero('BRL'));
        expect(sum.isZero()).toBe(true);
        expect(entries).toHaveLength(lines.length);
      }),
      { numRuns: 300 },
    );
  });

  it('propriedade: qualquer desequilíbrio de 1 centavo ou mais é recusado com LEDGER_UNBALANCED_JOURNAL', () => {
    fc.assert(
      fc.property(balancedLines, cents, (lines, extra) => {
        const broken = [...lines, { ...line('DEBIT', '1'), amount: extra }];
        expect(() => buildJournal(draft(broken))).toThrow(
          expect.objectContaining({ code: 'LEDGER_UNBALANCED_JOURNAL' }) as unknown as Error,
        );
      }),
      { numRuns: 200 },
    );
  });

  it('débito de 100,00 e crédito de 99,99 é recusado; uma linha só, valor zero ou com 3 casas também', () => {
    expect(() =>
      buildJournal(draft([line('DEBIT', '100.00'), line('CREDIT', '99.99', 'a')])),
    ).toThrow(/não fecha em zero/);
    expect(() => buildJournal(draft([line('DEBIT', '1.00')]))).toThrow(LedgerRuleError);
    expect(() => buildJournal(draft([line('DEBIT', '0'), line('CREDIT', '0', 'a')]))).toThrow(
      /positivo/,
    );
    expect(() =>
      buildJournal(draft([line('DEBIT', '1.005'), line('CREDIT', '1.005', 'a')])),
    ).toThrow(/arredonde/);
  });

  it('propriedade (RN-LED-002): o estorno inverte cada entrada e journal + estorno somam zero por conta', () => {
    fc.assert(
      fc.property(balancedLines, (lines) => {
        const entries = buildJournal(draft(lines));
        const reversal = buildJournal(
          reversalOf(
            { id: 'j1', idempotencyKey: 'test:1', entries },
            { bookingDate: D0, createdBy: 'test', reason: 'erro' },
          ),
        );
        entries.forEach((e, i) => expect(e.amount.plus(reversal[i]!.amount).isZero()).toBe(true));
      }),
      { numRuns: 100 },
    );
  });
});

describe('saldos (Financeiro §4)', () => {
  it('LED-001: 10.000 liquidados, compra 6.000 e venda 3.000 em D2 → P(D2) = 7.000 e sacável 7.000', () => {
    const days = settlementDays(calendar, D0);
    const b = computeBalances(
      {
        settled: brl('10000.00'),
        pending: [
          { valueDate: days.d2, amount: brl('-6000.00') },
          { valueDate: days.d2, amount: brl('3000.00') },
        ],
      },
      days,
      Money.zero('BRL'),
    );
    expect(b.projected.d0.toString()).toBe('10000.00');
    expect(b.projected.d1.toString()).toBe('10000.00');
    expect(b.projected.d2.toString()).toBe('7000.00');
    expect(b.withdrawable.toString()).toBe('7000.00');
  });

  it('RN-LED-020: crédito pendente não entra no sacável; holds descontam; nunca negativo', () => {
    const days = settlementDays(calendar, D0);
    const b = computeBalances(
      { settled: brl('100.00'), pending: [{ valueDate: days.d1, amount: brl('500.00') }] },
      days,
      brl('30.00'),
    );
    expect(b.projectedTotal.toString()).toBe('600.00');
    expect(b.withdrawable.toString()).toBe('70.00');
    expect(
      computeBalances(
        { settled: brl('10.00'), pending: [] },
        days,
        brl('30.00'),
      ).withdrawable.toString(),
    ).toBe('0.00');
  });

  it('D0/D1/D2 pelo calendário: no sábado, D0 é a segunda; sexta antes do Carnaval pula a segunda e a terça', () => {
    const sat = settlementDays(calendar, BusinessDate.parse('2026-01-10'));
    expect(sat.d0.toString()).toBe('2026-01-12');
    const carnival = settlementDays(calendar, BusinessDate.parse('2026-02-13'));
    expect([carnival.d1.toString(), carnival.d2.toString()]).toEqual(['2026-02-18', '2026-02-19']);
  });
});

describe('decisão do pagamento do depósito (RN-DEP-002..007)', () => {
  const intent = {
    status: 'PENDING' as const,
    amount: brl('100.00'),
    expiresAt: Instant.parse('2026-01-05T13:30:00Z'),
  };
  const base = {
    intent,
    paidAmount: brl('100.00'),
    paidAt: Instant.parse('2026-01-05T13:10:00Z'),
    payerIsHolder: true,
    accountStatus: 'ACTIVE',
  };
  it('credita o pagamento do titular com o valor e no prazo', () => {
    expect(decidePayment(base)).toEqual({ action: 'CREDIT' });
  });
  it('devolve terceiro, valor diferente, conta bloqueada, vencida e cobrança desconhecida', () => {
    expect(decidePayment({ ...base, payerIsHolder: false })).toMatchObject({
      reason: 'THIRD_PARTY_PAYER',
    });
    expect(decidePayment({ ...base, paidAmount: brl('99.99') })).toMatchObject({
      reason: 'AMOUNT_MISMATCH',
    });
    expect(decidePayment({ ...base, accountStatus: 'BLOCKED' })).toMatchObject({
      reason: 'ACCOUNT_NOT_ACTIVE',
    });
    expect(decidePayment({ ...base, paidAt: intent.expiresAt })).toEqual({
      action: 'REFUND',
      reason: 'INTENT_EXPIRED',
      expire: true,
    });
    expect(decidePayment({ ...base, intent: { ...intent, status: 'EXPIRED' } })).toMatchObject({
      reason: 'INTENT_EXPIRED',
      expire: false,
    });
    expect(decidePayment({ ...base, intent: { ...intent, status: 'CANCELED' } })).toMatchObject({
      reason: 'INTENT_NOT_PENDING',
    });
    expect(decidePayment({ ...base, intent: null })).toMatchObject({ reason: 'UNKNOWN_CHARGE' });
  });
});

describe('regras do saque (RN-SAQ-004, RN-SAQ-007)', () => {
  const rules = {
    min: brl('1.00'),
    daily: brl('100000.00'),
    nightly: brl('1000.00'),
    nightStart: '20:00',
    nightEnd: '06:00',
    reviewAbove: brl('50000.00'),
    maxAttempts: 5,
    retryWindowMs: 30 * 60_000,
  };
  const local = (time: string) => D0.atLocalTime(time);

  it('noite de 20h às 6h em São Paulo', () => {
    expect(isNight(local('19:59'), rules)).toBe(false);
    expect(isNight(local('20:00'), rules)).toBe(true);
    expect(isNight(local('05:59'), rules)).toBe(true);
    expect(isNight(local('06:00'), rules)).toBe(false);
  });

  it('R$ 1.500 às 22h estoura o noturno; de dia, o diário soma os saques do dia', () => {
    const usedToday = Money.zero('BRL');
    expect(
      checkLimits({ amount: brl('1500.00'), now: local('22:00'), usedToday, rules }),
    ).toMatchObject({
      limit: 'NIGHTLY',
    });
    expect(
      checkLimits({ amount: brl('1500.00'), now: local('10:00'), usedToday, rules }),
    ).toBeNull();
    expect(
      checkLimits({ amount: brl('0.01'), now: local('10:00'), usedToday: brl('100000.00'), rules }),
    ).toMatchObject({ limit: 'DAILY' });
  });

  it('backoff 1, 2, 4, 8 min: cinco tentativas dentro de 30 min e depois desiste', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
    let now = local('10:00');
    const first = now;
    const times = [now];
    for (let done = 1; ; done++) {
      const next = nextAttempt({ attemptsDone: done, firstAttemptAt: first, now, rules });
      if (!next) break;
      times.push((now = next));
    }
    expect(times).toHaveLength(5);
    expect(times.at(-1)!.epochMillis - first.epochMillis).toBe(15 * 60_000);
  });
});
