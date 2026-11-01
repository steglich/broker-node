import { Decimal, Instant } from '@broker/domain-kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buyHoldAmount, estimatedCosts } from '../src/domain/costs.js';
import { reduceHold, type Hold } from '../src/domain/holds.js';
import { decidePreTrade, decideWithdrawal } from '../src/domain/pretrade.js';
import {
  availableQuantity,
  buildTrade,
  buyingPower,
  emptyProjection,
  movePosition,
  replaceTrade,
  tradeKey,
  unbookedValue,
  withdrawable,
  type AccountProjection,
} from '../src/domain/projection.js';

const AT = Instant.parse('2026-03-03T13:00:00Z');
const INSTRUMENT = '019c0000-0000-7000-8000-000000000001';
const dec = (v: string) => new Decimal(v);

const account = (v: { p2?: string; settled?: string; status?: string | null } = {}) => {
  const p = emptyProjection('019c0000-0000-7000-8000-00000000000a');
  p.status = v.status === undefined ? 'ACTIVE' : v.status;
  p.settled = dec(v.settled ?? v.p2 ?? '0');
  p.d0 = p.settled;
  p.d1 = p.settled;
  p.d2 = dec(v.p2 ?? '0');
  return p;
};

const cashHold = (amount: string, quantity: number | null = 100): Hold => ({
  id: `h-${amount}`,
  accountId: 'a',
  type: quantity === null ? 'WITHDRAWAL' : 'ORDER_CASH',
  resource: 'CASH',
  originalAmount: dec(amount),
  remainingAmount: dec(amount),
  originalQuantity: quantity,
  remainingQuantity: quantity,
  referenceType: quantity === null ? 'WITHDRAWAL' : 'ORDER',
  referenceId: 'ref',
  status: 'ACTIVE',
  createdAt: AT,
  updatedAt: AT,
});

const positionHold = (quantity: number): Hold => ({
  ...cashHold('0', quantity),
  id: `p-${quantity}`,
  type: 'ORDER_POSITION',
  resource: INSTRUMENT,
});

const sold = (p: AccountProjection, notional: string) => {
  const t = buildTrade({
    tradeId: `t${p.trades.size}`,
    side: 'SELL',
    instrumentId: INSTRUMENT,
    quantity: 1,
    price: dec(notional),
    tradingDate: '2026-03-03',
    booked: false,
  });
  replaceTrade(p, tradeKey(t.tradeId, t.side), { ...t, estimatedCost: dec('0') });
};

describe('RN-HLD-002/003: valor do hold de compra', () => {
  it('Contratos §4: 250 a 38,45 reservam 9.615,67 (custos de 2,88 com margem de 10%)', () => {
    expect(estimatedCosts(dec('9612.50')).toFixed(2)).toBe('2.88');
    expect(buyHoldAmount(250, dec('38.45')).toFixed(2)).toBe('9615.67');
  });

  it('RN-FEE-030: custos arredondados por componente (R$ 1,15 em R$ 3.850,00)', () => {
    expect(estimatedCosts(dec('3850.00')).toFixed(2)).toBe('1.15');
  });
});

describe('RN-HLD-004: redução proporcional', () => {
  it('reduz na proporção e zera no fim; a última causa define o estado', () => {
    const half = reduceHold(cashHold('1000.30'), 50, 'FILL', AT);
    expect(half.remainingAmount.toFixed(2)).toBe('500.15');
    expect(half.status).toBe('ACTIVE');
    const done = reduceHold(half, 50, 'FILL', AT);
    expect(done.remainingAmount.toFixed(2)).toBe('0.00');
    expect(done.status).toBe('CONSUMED');
    expect(reduceHold(half, 50, 'CANCEL', AT).status).toBe('RELEASED');
  });

  it('propriedade: a ordem entre execuções e cancelamentos não muda o que resta', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.array(fc.integer({ min: 1, max: 3_000 }), { maxLength: 8 }),
        fc.integer({ min: 100, max: 10_000_000 }),
        (quantity, steps, cents) => {
          const amount = new Decimal(cents).dividedBy(100).toFixed(2);
          const apply = (order: number[]) =>
            order.reduce(
              (h, s, i) => reduceHold(h, s, i % 2 ? 'FILL' : 'CANCEL', AT),
              cashHold(amount, quantity),
            );
          const a = apply(steps);
          const b = apply([...steps].reverse());
          expect(a.remainingQuantity).toBe(b.remainingQuantity);
          expect(a.remainingAmount.toFixed(2)).toBe(b.remainingAmount.toFixed(2));
          expect(a.remainingAmount.greaterThanOrEqualTo(0)).toBe(true);
          expect(a.remainingAmount.lessThanOrEqualTo(amount)).toBe(true);
        },
      ),
    );
  });
});

describe('RN-BP-001..004: poder de compra', () => {
  it('RSK-001: P2 de 10.000, venda de 2.000 hoje e holds de 3.000 dão BP de 9.000', () => {
    const p = account({ p2: '10000.00' });
    sold(p, '2000.00');
    p.holds.set('h', cashHold('3000.00'));
    expect(buyingPower(p).toFixed(2)).toBe('9000.00');
  });

  it('RN-PTC-002: compra de 9.500 com BP de 9.000 é recusada com os valores', () => {
    const p = account({ p2: '9000.00' });
    const decision = decidePreTrade(
      p,
      {
        orderId: 'o',
        instrumentId: INSTRUMENT,
        side: 'BUY',
        quantity: 100,
        referencePrice: dec('94.97'),
        tradeIntent: 'NORMAL',
      },
      null,
    );
    expect(decision).toMatchObject({
      decision: 'REJECTED',
      rejectCode: 'INSUFFICIENT_BUYING_POWER',
      figures: { available: '9000.00', buyingPower: '9000.00' },
    });
  });

  it('U soma o sinal de cada ponta: compra e custos reduzem, venda aumenta', () => {
    const t = {
      tradeId: 't',
      side: 'BUY' as const,
      instrumentId: INSTRUMENT,
      quantity: 100,
      notional: dec('3850.00'),
      estimatedCost: dec('1.15'),
      tradingDate: '2026-03-03',
      booked: false,
      feesBooked: false,
    };
    expect(unbookedValue(t).toFixed(2)).toBe('-3851.15');
    expect(unbookedValue({ ...t, side: 'SELL' }).toFixed(2)).toBe('3848.85');
    expect(unbookedValue({ ...t, booked: true }).toFixed(2)).toBe('-1.15');
  });

  it('propriedade: U é sempre a soma das pontas, em qualquer sequência de troca', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            key: fc.integer({ min: 0, max: 4 }),
            cents: fc.integer({ min: 1, max: 1_000_000 }),
            booked: fc.boolean(),
            feesBooked: fc.boolean(),
            gone: fc.boolean(),
          }),
          { maxLength: 30 },
        ),
        (steps) => {
          const p = account();
          for (const s of steps) {
            const key = String(s.key);
            if (s.gone) replaceTrade(p, key, null);
            else
              replaceTrade(p, key, {
                ...buildTrade({
                  tradeId: key,
                  side: s.cents % 2 ? 'BUY' : 'SELL',
                  instrumentId: INSTRUMENT,
                  quantity: 1,
                  price: new Decimal(s.cents).dividedBy(100),
                  tradingDate: '2026-03-03',
                  booked: s.booked,
                }),
                feesBooked: s.feesBooked,
              });
          }
          const sum = [...p.trades.values()].reduce(
            (acc, t) => acc.plus(unbookedValue(t)),
            new Decimal(0),
          );
          expect(p.unbooked.toFixed(2)).toBe(sum.toFixed(2));
        },
      ),
    );
  });

  it('RN-RSK-002: conta nova não tem saldo nem status, e nada é aprovado', () => {
    const decision = decidePreTrade(
      account({ status: null, p2: '1000.00' }),
      {
        orderId: 'o',
        instrumentId: INSTRUMENT,
        side: 'BUY',
        quantity: 1,
        referencePrice: dec('1.00'),
        tradeIntent: 'NORMAL',
      },
      null,
    );
    expect(decision).toMatchObject({ decision: 'REJECTED', rejectCode: 'ACCOUNT_NOT_ACTIVE' });
  });
});

describe('RN-QD-001..003: quantidade disponível', () => {
  const sale = (quantity: number) => ({
    orderId: 'o',
    instrumentId: INSTRUMENT,
    side: 'SELL' as const,
    quantity,
    referencePrice: dec('10.00'),
    tradeIntent: 'NORMAL' as const,
  });

  it('Q_disp desconta os holds de venda; acima dele é INSUFFICIENT_POSITION sem margem', () => {
    const p = account();
    movePosition(p, INSTRUMENT, 300);
    p.holds.set('p', positionHold(100));
    expect(availableQuantity(p, INSTRUMENT)).toBe(200);
    expect(decidePreTrade(p, sale(200), null)).toMatchObject({
      decision: 'APPROVED',
      classification: 'COVERED_SELL',
    });
    expect(decidePreTrade(p, sale(201), null)).toMatchObject({
      decision: 'REJECTED',
      classification: 'SHORT_SALE',
      rejectCode: 'INSUFFICIENT_POSITION',
      figures: { required: '201', available: '200' },
    });
  });

  it('Contas §7.2: RESTRICTED vende posição, mas não compra', () => {
    const p = account({ status: 'RESTRICTED', p2: '1000.00' });
    movePosition(p, INSTRUMENT, 100);
    expect(decidePreTrade(p, sale(100), null).decision).toBe('APPROVED');
    expect(decidePreTrade(p, { ...sale(1), side: 'BUY', quantity: 1 }, null)).toMatchObject({
      rejectCode: 'ACCOUNT_NOT_ACTIVE',
    });
  });
});

describe('RN-ALT-004: alteração pela diferença da reserva', () => {
  it('só a diferença precisa caber no poder de compra', () => {
    const p = account({ p2: '1500.00' });
    const current = cashHold('1000.30');
    p.holds.set(current.id, current);
    const replace = (quantity: number) =>
      decidePreTrade(
        p,
        {
          orderId: 'o',
          instrumentId: INSTRUMENT,
          side: 'BUY',
          quantity,
          referencePrice: dec('10.00'),
          tradeIntent: 'NORMAL',
        },
        current,
      );
    expect(replace(149).decision).toBe('APPROVED');
    expect(replace(160)).toMatchObject({ decision: 'REJECTED' });
  });
});

describe('RSK-030: sacável da projeção', () => {
  it('RN-LED-020: mínimo dos saldos, menos os holds, nunca negativo', () => {
    const p = account({ settled: '10000.00', p2: '7000.00' });
    expect(withdrawable(p).toFixed(2)).toBe('7000.00');
    p.holds.set('h', cashHold('8000.00'));
    expect(withdrawable(p).toFixed(2)).toBe('0.00');
  });

  it('compra executada e sem lançamento não pode sair em saque; venda do dia só em D+2', () => {
    const p = account({ p2: '10000.00' });
    replaceTrade(
      p,
      'buy',
      buildTrade({
        tradeId: 'buy',
        side: 'BUY',
        instrumentId: INSTRUMENT,
        quantity: 100,
        price: dec('80.00'),
        tradingDate: '2026-03-03',
        booked: false,
      }),
    );
    // 8.000,00 de principal e 2,40 de custos estimados.
    expect(withdrawable(p).toFixed(2)).toBe('1997.60');
    expect(decideWithdrawal(p, dec('1997.61'))).toMatchObject({
      decision: 'REJECTED',
      rejectCode: 'INSUFFICIENT_WITHDRAWABLE_BALANCE',
    });

    const q = account({ p2: '10000.00' });
    sold(q, '5000.00');
    expect(withdrawable(q).toFixed(2)).toBe('10000.00');
    expect(buyingPower(q).toFixed(2)).toBe('15000.00');
  });
});
