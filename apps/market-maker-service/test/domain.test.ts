import { Decimal } from '@broker/domain-kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SMM_PARAMS, resolveParams, type SmmParams } from '../src/domain/params.js';
import { effectivePhase, quoteMode } from '../src/domain/phases.js';
import { applyFill, EMPTY_POSITION, unrealizedPnl } from '../src/domain/position.js';
import {
  computeQuotes,
  diffQuotes,
  effectiveSpreadBps,
  inventoryLimit,
  levelQuantity,
  planSweep,
  stalenessMultiplier,
  type LiveOrder,
  type QuoteInput,
} from '../src/domain/quotes.js';

const tick = new Decimal('0.01');
const input = (over: Partial<QuoteInput> = {}): QuoteInput => ({
  reference: new Decimal('38.50'),
  tick,
  lotSize: 100,
  inventory: 0,
  params: DEFAULT_SMM_PARAMS,
  single: false,
  spreadMultiplier: 1,
  band: null,
  oddLot: true,
  ...over,
});
const main = (q: ReturnType<typeof computeQuotes>, side: 'BUY' | 'SELL') =>
  q.filter((l) => l.board === 'MAIN' && l.side === side);
const mid = (q: ReturnType<typeof computeQuotes>) =>
  main(q, 'BUY')[0]!.price.plus(main(q, 'SELL')[0]!.price).div(2);

describe('cálculo das cotações (Motor §6.3)', () => {
  it('inventário zero: melhor bid abaixo e melhor ask acima da referência, múltiplos do tick', () => {
    const q = computeQuotes(input());
    expect(main(q, 'BUY')[0]!.price.toFixed()).toBe('38.48');
    expect(main(q, 'SELL')[0]!.price.toFixed()).toBe('38.52');
    for (const l of q) expect(l.price.div(tick).isInteger()).toBe(true);
  });

  it('passo, níveis e quantidade crescente pelo multiplicador, em lotes', () => {
    const q = computeQuotes(input());
    expect(main(q, 'BUY').map((l) => l.price.toFixed())).toEqual([
      '38.48',
      '38.46',
      '38.44',
      '38.42',
      '38.4',
    ]);
    expect(main(q, 'SELL').map((l) => l.quantity)).toEqual([1000, 1500, 2200, 3300, 5000]);
    expect(levelQuantity(DEFAULT_SMM_PARAMS, 100, 2)).toBe(2200);
  });

  it('inventário comprado: o centro fica abaixo da referência; vendido, acima', () => {
    const limit = inventoryLimit(DEFAULT_SMM_PARAMS, 100);
    expect(mid(computeQuotes(input({ inventory: limit / 2 }))).lessThan('38.50')).toBe(true);
    expect(mid(computeQuotes(input({ inventory: -limit / 2 }))).greaterThan('38.50')).toBe(true);
  });

  it('meio-spread e passo têm o tick como piso', () => {
    const q = computeQuotes(input({ reference: new Decimal('1.00') }));
    expect(main(q, 'BUY')[0]!.price.toFixed()).toBe('0.99');
    expect(main(q, 'SELL')[0]!.price.toFixed()).toBe('1.01');
    expect(main(q, 'BUY')[1]!.price.toFixed()).toBe('0.98');
  });

  it('fracionário: um nível por lado, de lot_size − 1, no melhor preço', () => {
    const odd = computeQuotes(input()).filter((l) => l.board === 'ODD_LOT');
    expect(odd.map((l) => [l.side, l.price.toFixed(), l.quantity])).toEqual([
      ['BUY', '38.48', 99],
      ['SELL', '38.52', 99],
    ]);
    expect(computeQuotes(input({ oddLot: false })).some((l) => l.board === 'ODD_LOT')).toBe(false);
    expect(computeQuotes(input({ lotSize: 1 })).some((l) => l.board === 'ODD_LOT')).toBe(false);
  });

  it('modo de um nível: ref ± meio-spread, sem inclinação, com a quantidade do nível 1', () => {
    const q = computeQuotes(input({ single: true, inventory: 100_000 }));
    expect(q.map((l) => [l.side, l.price.toFixed(), l.quantity])).toEqual([
      ['BUY', '38.48', 1000],
      ['SELL', '38.52', 1000],
    ]);
  });
});

describe('garantias de forma e de inventário (RN-SMM-001/002)', () => {
  const params = fc.record({
    spreadBps: fc.integer({ min: 1, max: 500 }),
    levels: fc.integer({ min: 1, max: 10 }),
    levelStepBps: fc.integer({ min: 1, max: 100 }),
    baseQuantityLots: fc.integer({ min: 1, max: 50 }),
    inventoryLimitLots: fc.integer({ min: 1, max: 3000 }),
    skewFactor: fc.constantFrom('0', '0.25', '0.5', '1', '3'),
    levelMultiplier: fc.constantFrom('1', '1.5', '2'),
  });
  const quoteInput = fc
    .record({
      cents: fc.integer({ min: 1, max: 5_000_000 }),
      lotSize: fc.constantFrom(1, 10, 100),
      params,
      inventoryRatio: fc.double({ min: -1.5, max: 1.5, noNaN: true }),
      multiplier: fc.constantFrom(1, 2, 4, 8),
      single: fc.boolean(),
      bandPct: fc.option(fc.constantFrom('0.20', '0.05', '0.001'), { nil: null }),
      bandSkewCents: fc.integer({ min: -200, max: 200 }),
    })
    .map((r): QuoteInput => {
      const reference = new Decimal(r.cents).div(10_000);
      const p: SmmParams = { ...DEFAULT_SMM_PARAMS, ...r.params };
      const bandRef = reference.plus(new Decimal(r.bandSkewCents).div(100));
      return {
        reference,
        tick,
        lotSize: r.lotSize,
        inventory: Math.trunc(r.inventoryRatio * inventoryLimit(p, r.lotSize)),
        params: p,
        single: r.single,
        spreadMultiplier: r.multiplier,
        oddLot: true,
        band:
          r.bandPct && bandRef.greaterThan(0)
            ? {
                low: bandRef.times(new Decimal(1).minus(r.bandPct)),
                high: bandRef.times(new Decimal(1).plus(r.bandPct)),
              }
            : null,
      };
    });

  it('RN-SMM-002: bid_1 < ask_1, preços > 0, no tick e dentro do túnel', () => {
    fc.assert(
      fc.property(quoteInput, (i) => {
        const q = computeQuotes(i);
        const bids = main(q, 'BUY');
        const asks = main(q, 'SELL');
        if (bids[0] && asks[0]) expect(bids[0].price.lessThan(asks[0].price)).toBe(true);
        for (const l of q) {
          expect(l.price.greaterThan(0)).toBe(true);
          expect(l.price.div(tick).isInteger()).toBe(true);
          if (i.band) {
            expect(l.price.greaterThanOrEqualTo(i.band.low)).toBe(true);
            expect(l.price.lessThanOrEqualTo(i.band.high)).toBe(true);
          }
        }
      }),
    );
  });

  it('RN-SMM-001/021: as ofertas nunca levam o inventário além do limite, nos dois lados', () => {
    fc.assert(
      fc.property(quoteInput, (i) => {
        const limit = inventoryLimit(i.params, i.lotSize);
        const q = computeQuotes(i);
        const sum = (side: 'BUY' | 'SELL') =>
          q.filter((l) => l.side === side).reduce((n, l) => n + l.quantity, 0);
        expect(i.inventory + sum('BUY')).toBeLessThanOrEqual(Math.max(limit, i.inventory));
        expect(i.inventory - sum('SELL')).toBeGreaterThanOrEqual(Math.min(-limit, i.inventory));
        for (const l of q) if (l.board === 'MAIN') expect(l.quantity % i.lotSize).toBe(0);
      }),
    );
  });

  it('RN-SMM-001: no limite comprado não há compra; no vendido não há venda', () => {
    const limit = inventoryLimit(DEFAULT_SMM_PARAMS, 100);
    const long = computeQuotes(input({ inventory: limit }));
    expect(long.filter((l) => l.side === 'BUY')).toEqual([]);
    expect(main(long, 'SELL').length).toBeGreaterThan(0);
    const short = computeQuotes(input({ inventory: -limit }));
    expect(short.filter((l) => l.side === 'SELL')).toEqual([]);
    expect(main(short, 'BUY').length).toBeGreaterThan(0);
  });

  it('RN-SMM-002: nível fora do túnel some, em vez de ir para a borda', () => {
    const q = computeQuotes(
      input({ band: { low: new Decimal('38.45'), high: new Decimal('38.53') } }),
    );
    expect(main(q, 'BUY').map((l) => l.price.toFixed())).toEqual(['38.48', '38.46']);
    expect(main(q, 'SELL').map((l) => l.price.toFixed())).toEqual(['38.52']);
  });
});

describe('varredura (RN-SMM-012)', () => {
  const sweepInput = { inventory: 0, lotSize: 100, params: DEFAULT_SMM_PARAMS };

  it('sem oferta de cliente cruzada não há varredura e a cotação fica igual', () => {
    const q = computeQuotes(input());
    const plan = planSweep(
      q,
      [{ side: 'SELL', price: new Decimal('38.60'), quantity: 500 }],
      sweepInput,
    );
    expect(plan.sweep).toBeNull();
    expect(plan.quotes).toEqual(q);
  });

  it('compra o que o novo bid cruza, no melhor preço da cotação', () => {
    const q = computeQuotes(input());
    const plan = planSweep(
      q,
      [{ side: 'SELL', price: new Decimal('38.40'), quantity: 300 }],
      sweepInput,
    );
    expect(plan.sweep).toMatchObject({ side: 'BUY', quantity: 300 });
    expect(plan.sweep!.price.toFixed()).toBe('38.48');
    expect(main(plan.quotes, 'BUY')).toHaveLength(5);
  });

  it('para no limite por recotação, e nenhuma cotação cruza o que sobrou de cliente', () => {
    const plan = planSweep(
      computeQuotes(input()),
      [
        { side: 'SELL', price: new Decimal('38.30'), quantity: 4000 },
        { side: 'SELL', price: new Decimal('38.44'), quantity: 9000 },
      ],
      sweepInput,
    );
    expect(plan.sweep!.quantity).toBe(50 * 100);
    // 4000 a 38,30 e 1000 a 38,44: sobram 8000 a 38,44, e o FMS não pode ficar em 38,44 ou acima.
    expect(main(plan.quotes, 'BUY').map((l) => l.price.toFixed())).toEqual(['38.42', '38.4']);
    expect(plan.quotes.some((l) => l.board === 'ODD_LOT' && l.side === 'BUY')).toBe(true);
  });

  it('do lado da venda, quando a referência cai abaixo de compra de cliente', () => {
    const plan = planSweep(
      computeQuotes(input()),
      [{ side: 'BUY', price: new Decimal('38.60'), quantity: 200 }],
      sweepInput,
    );
    expect(plan.sweep).toMatchObject({ side: 'SELL', quantity: 200 });
  });

  it('respeita a capacidade do inventário, na varredura e nas cotações do mesmo lado', () => {
    const limit = inventoryLimit(DEFAULT_SMM_PARAMS, 100);
    const inventory = limit - 300;
    const plan = planSweep(
      computeQuotes(input({ inventory })),
      [{ side: 'SELL', price: new Decimal('38.40'), quantity: 1000 }],
      { ...sweepInput, inventory },
    );
    expect(plan.sweep!.quantity).toBe(300);
    expect(plan.quotes.filter((l) => l.side === 'BUY')).toEqual([]);
  });

  it('`smm_max_sweep_lots` zero desliga a varredura sem deixar cotação cruzando', () => {
    const plan = planSweep(
      computeQuotes(input()),
      [{ side: 'SELL', price: new Decimal('38.47'), quantity: 100 }],
      { ...sweepInput, params: { ...DEFAULT_SMM_PARAMS, maxSweepLots: 0 } },
    );
    expect(plan.sweep).toBeNull();
    expect(main(plan.quotes, 'BUY')[0]!.price.toFixed()).toBe('38.46');
  });
});

describe('recotação (RN-SMM-011)', () => {
  const live = (over: Partial<LiveOrder>): LiveOrder => ({
    orderId: 'o1',
    board: 'MAIN',
    side: 'BUY',
    price: '38.48',
    remaining: 1000,
    status: 'BOOKED',
    sweep: false,
    ...over,
  });
  const level = (price: string, quantity = 1000) => ({
    board: 'MAIN' as const,
    side: 'BUY' as const,
    price: new Decimal(price),
    quantity,
  });

  it('o nível igual fica; o que mudou cancela e entra como ordem nova', () => {
    const diff = diffQuotes(
      [live({ orderId: 'same' }), live({ orderId: 'moved', price: '38.46' })],
      [level('38.48'), level('38.47')],
    );
    expect(diff.cancel.map((o) => o.orderId)).toEqual(['moved']);
    expect(diff.place.map((l) => l.price.toFixed())).toEqual(['38.47']);
  });

  it('o nível parcialmente executado é refeito na quantidade cheia', () => {
    const diff = diffQuotes([live({ remaining: 400 })], [level('38.48')]);
    expect(diff.cancel).toHaveLength(1);
    expect(diff.place).toHaveLength(1);
  });

  it('sem cotação desejada, cancela tudo; varredura e cancelamento em curso não repetem', () => {
    const diff = diffQuotes(
      [
        live({ orderId: 'a' }),
        live({ orderId: 'b', sweep: true }),
        live({ orderId: 'c', status: 'CANCELING' }),
      ],
      [],
    );
    expect(diff.cancel.map((o) => o.orderId)).toEqual(['a']);
  });
});

describe('referência defasada (RN-SMM-032)', () => {
  const hour = 3_600_000;
  it.each([
    [null, 1],
    [0, 1],
    [hour - 1, 1],
    [hour, 2],
    [2 * hour, 4],
    [3 * hour, 8],
    [4 * hour - 1, 8],
  ])('com %s ms de defasagem o spread é ×%i', (ms, expected) => {
    expect(stalenessMultiplier(ms)).toBe(expected);
  });

  it('a partir da 4ª hora para de cotar', () => {
    expect(stalenessMultiplier(4 * hour)).toBeNull();
  });

  it('três horas: o spread usado é 8 vezes o configurado', () => {
    const q = computeQuotes(input({ spreadMultiplier: stalenessMultiplier(3 * hour)! }));
    // meio-spread 38,50 × 10 × 8 / 2 / 10000 = 0,154
    expect(main(q, 'BUY')[0]!.price.toFixed()).toBe('38.34');
    expect(main(q, 'SELL')[0]!.price.toFixed()).toBe('38.66');
  });
});

describe('fases (Motor §6.6, RN-SES-001)', () => {
  it.each([
    ['PRE_TRADING', 'PLAN'],
    ['PRE_OPENING', 'SINGLE'],
    ['CLOSING_CALL', 'SINGLE'],
    ['VOLATILITY_AUCTION', 'SINGLE'],
    ['CONTINUOUS', 'FULL'],
    ['HALTED', 'NONE'],
    ['POST_CLOSE', 'NONE'],
    ['CLOSED', 'NONE'],
    ['AFTER_MARKET', 'NONE'],
  ] as const)('%s → %s', (phase, mode) => {
    expect(quoteMode(phase)).toBe(mode);
  });

  it('vale a mais restritiva entre mercado e instrumento', () => {
    expect(effectivePhase('CONTINUOUS', 'HALTED')).toBe('HALTED');
    expect(effectivePhase('POST_CLOSE', 'CONTINUOUS')).toBe('POST_CLOSE');
    expect(effectivePhase('CONTINUOUS', null)).toBe('CONTINUOUS');
  });
});

describe('posição e resultado (RN-SMM-031)', () => {
  const d = (v: string) => new Decimal(v);

  it('custo médio ao aumentar, resultado ao reduzir', () => {
    let p = applyFill(EMPTY_POSITION, 'BUY', 100, d('10'));
    p = applyFill(p, 'BUY', 100, d('12'));
    expect(p.averageCost.toFixed()).toBe('11');
    p = applyFill(p, 'SELL', 50, d('15'));
    expect(p.inventory).toBe(150);
    expect(p.realizedPnl.toFixed()).toBe('200');
    expect(p.averageCost.toFixed()).toBe('11');
    expect(unrealizedPnl(p, d('12')).toFixed()).toBe('150');
    expect(p.volume).toBe(250);
    expect(p.cashFlow.toFixed()).toBe('-1450');
  });

  it('inventário vendido lucra quando o preço cai, e virar de lado reabre ao preço do negócio', () => {
    let p = applyFill(EMPTY_POSITION, 'SELL', 100, d('20'));
    expect(unrealizedPnl(p, d('18')).toFixed()).toBe('200');
    p = applyFill(p, 'BUY', 150, d('18'));
    expect(p.realizedPnl.toFixed()).toBe('200');
    expect(p.inventory).toBe(50);
    expect(p.averageCost.toFixed()).toBe('18');
  });

  it('zerar limpa o custo médio', () => {
    let p = applyFill(EMPTY_POSITION, 'BUY', 100, d('10'));
    p = applyFill(p, 'SELL', 100, d('11'));
    expect(p.inventory).toBe(0);
    expect(p.averageCost.toFixed()).toBe('0');
    expect(p.realizedPnl.toFixed()).toBe('100');
  });

  it('spread efetivo em bps sobre o meio; nulo sem as duas pontas', () => {
    expect(effectiveSpreadBps(d('99'), d('101'))!.toFixed()).toBe('200');
    expect(effectiveSpreadBps(null, d('101'))).toBeNull();
  });

  it('a vigência mais recente de cada campo vence, e o instrumento vence o global', () => {
    const p = resolveParams([{ levels: 3 }, { levels: 4, spreadBps: 20 }], [{ spreadBps: 30 }]);
    expect(p).toMatchObject({ levels: 4, spreadBps: 30, skewFactor: '0.5' });
  });
});
