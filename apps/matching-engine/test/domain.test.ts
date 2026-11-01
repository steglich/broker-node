import { EngineAuctionCompletedV1 } from '@broker/contracts/events/engine.auction_completed/v1';
import { EngineAuctionIndicativeV1 } from '@broker/contracts/events/engine.auction_indicative/v1';
import { EngineAuctionTriggeredV1 } from '@broker/contracts/events/engine.auction_triggered/v1';
import { EngineBookChangedV1 } from '@broker/contracts/events/engine.book_changed/v1';
import { EngineOrderBookedV1 } from '@broker/contracts/events/engine.order_booked/v1';
import { EngineOrderCanceledV1 } from '@broker/contracts/events/engine.order_canceled/v1';
import { EngineOrderRejectedV1 } from '@broker/contracts/events/engine.order_rejected/v1';
import { EngineOrderReplacedV1 } from '@broker/contracts/events/engine.order_replaced/v1';
import { EngineTradeBustedV1 } from '@broker/contracts/events/engine.trade_busted/v1';
import { EngineTradeBustRejectedV1 } from '@broker/contracts/events/engine.trade_bust_rejected/v1';
import { EngineTradeExecutedV1 } from '@broker/contracts/events/engine.trade_executed/v1';
import { uuidv7 } from '@broker/ids';
import { validationErrors, type EventDefinition, type Envelope } from '@broker/messaging';
import { seededRandom } from '@broker/testing';
import { describe, expect, it } from 'vitest';
import { decodeCommand, InvalidCommandError } from '../src/application/commands.js';
import { deterministicId, hash32, IdKind, randomEndOffset } from '../src/domain/deterministic.js';
import { InstrumentEngine } from '../src/domain/engine.js';
import type { EngineCommand, EngineInput, EngineOutput } from '../src/domain/inputs.js';
import { bandAround, formatPrice, parsePrice, parseRate } from '../src/domain/price.js';

const START = Date.UTC(2026, 2, 3, 13, 0, 0);
const INSTRUMENT = '0192a3c0-0000-7000-8000-00000000aaaa';

/** Monta entradas com `input_seq` contínuo. */
function feeder(engine: InstrumentEngine) {
  let seq = engine.inputSeq;
  let now = START;
  return (command: EngineCommand, at?: number): EngineOutput[] => {
    now = at ?? now + 1000;
    return engine.process({
      inputSeq: ++seq,
      ts: now,
      tradingDate: '2026-03-03',
      seed: 7,
      command,
    });
  };
}

const order = (
  orderId: string,
  side: 'BUY' | 'SELL',
  quantity: number,
  limitPrice: string,
  accountId = `acc-${orderId}`,
): EngineCommand => ({
  kind: 'NewOrder',
  orderId,
  accountId,
  participantType: 'CUSTOMER',
  board: 'MAIN',
  side,
  type: 'LIMIT',
  quantity,
  limitPrice,
  timeInForce: 'DAY',
  stpPolicy: 'CANCEL_AGGRESSOR',
});

const bands = (overrides: Partial<Extract<EngineCommand, { kind: 'BandUpdate' }>> = {}) =>
  ({
    kind: 'BandUpdate',
    bandReferencePrice: '10.00',
    rejectionBandPct: '0.20',
    staticAuctionBandPct: '0.08',
    dynamicAuctionBandPct: '0.03',
    volatilityAuctionDurationS: 300,
    auctionRandomEndMaxS: 30,
    ...overrides,
  }) as EngineCommand;

const types = (outputs: readonly EngineOutput[]) => outputs.map((o) => o.eventType);
const ofType = (outputs: readonly EngineOutput[], type: string) =>
  outputs.filter((o) => o.eventType === type);

describe('preços', () => {
  it('converte sem passar por ponto flutuante', () => {
    expect(parsePrice('10.01')).toBe(1_001_000_000);
    expect(formatPrice(parsePrice('10.01'))).toBe('10.01');
    expect(formatPrice(parsePrice('10'))).toBe('10.00');
    expect(formatPrice(parsePrice('38.5115'))).toBe('38.5115');
    expect(() => parsePrice('10,01')).toThrow();
  });

  it('o túnel arredonda para dentro e a borda ainda é aceita', () => {
    const band = bandAround(parsePrice('10.01'), parseRate('0.03'));
    expect(formatPrice(band.low)).toBe('9.7097');
    expect(formatPrice(band.high)).toBe('10.3103');
  });
});

describe('IDs e acaso determinísticos', () => {
  it('o mesmo livro e a mesma sequência dão o mesmo UUID válido; outro livro, outro', () => {
    const hash = hash32(INSTRUMENT);
    const id = deterministicId(START, hash, 'MAIN', 7, IdKind.TRADE);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicId(START, hash, 'MAIN', 7, IdKind.TRADE)).toBe(id);
    expect(deterministicId(START, hash, 'ODD_LOT', 7, IdKind.TRADE)).not.toBe(id);
    expect(deterministicId(START, hash, 'MAIN', 8, IdKind.TRADE)).not.toBe(id);
    expect(deterministicId(START, hash, 'MAIN', 7, IdKind.EVENT)).not.toBe(id);
  });

  it('o atraso aleatório fica na janela e depende só da semente (RN-AUC-033)', () => {
    for (let seed = 0; seed < 2000; seed++) {
      const offset = randomEndOffset(seed, 30_000);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual(30_000);
      expect(randomEndOffset(seed, 30_000)).toBe(offset);
    }
    expect(randomEndOffset(1, 0)).toBe(0);
  });
});

describe('fases e leilões', () => {
  it('recusa fora da sequência: a falha é do chamador, não do livro (RN-ME-003)', () => {
    const engine = new InstrumentEngine(INSTRUMENT);
    expect(() =>
      engine.process({
        inputSeq: 5,
        ts: START,
        tradingDate: '2026-03-03',
        seed: 1,
        command: { kind: 'Tick' },
      }),
    ).toThrow(/fora de ordem/);
  });

  it('IOC e FOK não entram em leilão e MARKET não entra na call (RN-AUC-012, RN-SES-004)', () => {
    const engine = new InstrumentEngine(INSTRUMENT);
    const feed = feeder(engine);
    feed({ kind: 'PhaseChange', phase: 'PRE_OPENING' });
    const ioc = { ...order('A', 'BUY', 100, '10.00'), timeInForce: 'IOC' } as EngineCommand;
    expect(ofType(feed(ioc), 'engine.order_rejected')[0]?.payload['reason']).toBe('BOOK_NOT_OPEN');
    feed({ kind: 'PhaseChange', phase: 'CLOSING_CALL' });
    const market: EngineCommand = {
      kind: 'NewOrder',
      orderId: 'B',
      accountId: 'x',
      participantType: 'CUSTOMER',
      board: 'MAIN',
      side: 'BUY',
      type: 'MARKET',
      quantity: 100,
      timeInForce: 'DAY',
      stpPolicy: 'CANCEL_AGGRESSOR',
    };
    expect(ofType(feed(market), 'engine.order_rejected')[0]?.payload['reason']).toBe(
      'BOOK_NOT_OPEN',
    );
  });

  it('na call só cancela ou reduz: preço pior e aumento são recusados (RN-SES-004)', () => {
    const engine = new InstrumentEngine(INSTRUMENT);
    const feed = feeder(engine);
    feed({ kind: 'PhaseChange', phase: 'CONTINUOUS' });
    feed(order('A', 'BUY', 200, '10.00'));
    feed({ kind: 'PhaseChange', phase: 'CLOSING_CALL' });
    const replace = (fields: { newQuantity?: number; newLimitPrice?: string }, version = 1) =>
      feed({ kind: 'ReplaceOrder', orderId: 'A', expectedVersion: version, ...fields });
    expect(types(replace({ newLimitPrice: '9.99' }))).toContain('engine.order_rejected');
    expect(types(replace({ newQuantity: 300 }))).toContain('engine.order_rejected');
    expect(
      ofType(replace({ newQuantity: 100 }), 'engine.order_replaced')[0]?.payload,
    ).toMatchObject({ priorityKept: true, version: 2 });
  });

  it('prorrogação muda só o fim previsto; o fim efetivo sai da semente daquele leilão', () => {
    const engine = new InstrumentEngine(INSTRUMENT);
    const feed = feeder(engine);
    feed(bands());
    const end = START + 60_000;
    const open = {
      kind: 'PhaseChange',
      phase: 'PRE_OPENING',
      auctionId: 'L1',
      auctionType: 'OPENING',
      auctionEndAt: new Date(end).toISOString(),
      randomSeed: '42',
    } as const;
    feed(open);
    feed(order('B', 'BUY', 100, '10.00'));
    feed(order('S', 'SELL', 100, '10.00'));
    const later = end + 120_000;
    feed({ ...open, auctionEndAt: new Date(later).toISOString() });
    feed({ kind: 'PhaseChange', phase: 'CONTINUOUS', concludesAuctionId: 'L1' }, later);
    const deadline = later + randomEndOffset(42, 30_000);
    expect(engine.nextDeadline()).toBe(deadline);
    expect(engine.phase).toBe('PRE_OPENING');
    const done = feed({ kind: 'Tick' }, deadline);
    expect(ofType(done, 'engine.trade_executed')[0]?.payload).toMatchObject({
      aggressorSide: 'NONE',
      auctionId: 'L1',
      executedAt: new Date(deadline).toISOString(),
    });
    expect(engine.phase).toBe('CONTINUOUS');
    expect(engine.nextDeadline()).toBeNull();
  });

  it('um comando que chega depois do instante sorteado encontra o leilão já concluído', () => {
    const engine = new InstrumentEngine(INSTRUMENT);
    const feed = feeder(engine);
    feed(bands({ auctionRandomEndMaxS: 0 }));
    feed({
      kind: 'PhaseChange',
      phase: 'PRE_OPENING',
      auctionId: 'L1',
      auctionEndAt: new Date(START + 10_000).toISOString(),
    });
    feed(order('B', 'BUY', 100, '10.00'));
    feed(order('S', 'SELL', 100, '10.00'));
    // A sessão manda concluir antes do fim previsto: a conclusão espera.
    feed({ kind: 'PhaseChange', phase: 'CONTINUOUS', concludesAuctionId: 'L1' }, START + 5_000);
    const out = feed(order('C', 'BUY', 100, '9.00'), START + 20_000);
    const kinds = types(out);
    expect(kinds.indexOf('engine.trade_executed')).toBeLessThan(
      kinds.indexOf('engine.order_booked'),
    );
    expect(engine.phase).toBe('CONTINUOUS');
  });

  it('política de conclusão: o preço teórico é trazido para o túnel (RN-AUC-003)', () => {
    const engine = new InstrumentEngine(INSTRUMENT);
    const feed = feeder(engine);
    feed(bands({ auctionRandomEndMaxS: 0 }));
    feed({
      kind: 'PhaseChange',
      phase: 'PRE_OPENING',
      auctionId: 'L1',
      auctionEndAt: new Date(START).toISOString(),
    });
    feed(order('B', 'BUY', 100, '11.50'));
    feed(order('S', 'SELL', 100, '11.00'));
    const out = feed({
      kind: 'PhaseChange',
      phase: 'CONTINUOUS',
      concludesAuctionId: 'L1',
      priceLimit: { min: '9.20', max: '10.80' },
    });
    // Em 10,80 só a compra aceita: nada executa e o leilão termina sem preço.
    expect(ofType(out, 'engine.auction_completed')[0]?.payload).toMatchObject({
      price: null,
      quantity: 0,
    });
  });

  it('suspensão abandona o leilão sem executar e mantém o livro (RN-HLT-001)', () => {
    const engine = new InstrumentEngine(INSTRUMENT);
    const feed = feeder(engine);
    feed({ kind: 'PhaseChange', phase: 'PRE_OPENING', auctionId: 'L1' });
    feed(order('B', 'BUY', 100, '10.00'));
    feed(order('S', 'SELL', 100, '10.00'));
    const out = feed({ kind: 'PhaseChange', phase: 'HALTED' });
    expect(types(out)).not.toContain('engine.trade_executed');
    expect(engine.bookView('MAIN').bids).toHaveLength(1);
    expect(engine.nextDeadline()).toBeNull();
  });

  it('STP no leilão: a que chegou depois faz o papel de agressora', () => {
    const engine = new InstrumentEngine(INSTRUMENT);
    const feed = feeder(engine);
    feed({
      kind: 'PhaseChange',
      phase: 'PRE_OPENING',
      auctionId: 'L1',
      auctionEndAt: new Date(START).toISOString(),
    });
    feed(order('B', 'BUY', 100, '10.00', 'X'));
    feed(order('S1', 'SELL', 100, '10.00', 'X'));
    feed(order('S2', 'SELL', 100, '10.00', 'Y'));
    const out = feed({ kind: 'PhaseChange', phase: 'CONTINUOUS', concludesAuctionId: 'L1' });
    expect(ofType(out, 'engine.order_canceled')[0]?.payload).toMatchObject({
      orderId: 'S1',
      reason: 'SELF_TRADE_PREVENTION',
    });
    expect(ofType(out, 'engine.trade_executed')[0]?.payload).toMatchObject({
      buyOrderId: 'B',
      sellOrderId: 'S2',
    });
  });

  it('no leilão o MARKET respeita o preço de proteção (RN-AUC-031)', () => {
    const engine = new InstrumentEngine(INSTRUMENT);
    const feed = feeder(engine);
    feed({
      kind: 'PhaseChange',
      phase: 'PRE_OPENING',
      auctionId: 'L1',
      auctionEndAt: new Date(START).toISOString(),
    });
    feed({
      kind: 'NewOrder',
      orderId: 'M',
      accountId: 'X',
      participantType: 'CUSTOMER',
      board: 'MAIN',
      side: 'BUY',
      type: 'MARKET',
      quantity: 100,
      protectionPrice: '10.00',
      timeInForce: 'DAY',
      stpPolicy: 'CANCEL_AGGRESSOR',
    });
    feed(order('S', 'SELL', 100, '10.50'));
    const out = feed({ kind: 'PhaseChange', phase: 'CONTINUOUS', concludesAuctionId: 'L1' });
    expect(types(out)).not.toContain('engine.trade_executed');
    expect(ofType(out, 'engine.order_canceled')[0]?.payload).toMatchObject({
      orderId: 'M',
      reason: 'MARKET_NO_LIQUIDITY',
    });
  });

  it('agressão no fracionário fora do túnel abre o leilão do instrumento, pelo MAIN', () => {
    const engine = new InstrumentEngine(INSTRUMENT);
    const feed = feeder(engine);
    feed(bands());
    feed({ kind: 'PhaseChange', phase: 'CONTINUOUS' });
    feed({ ...order('S', 'SELL', 50, '11.00'), board: 'ODD_LOT' } as EngineCommand);
    const out = feed({ ...order('B', 'BUY', 50, '11.00'), board: 'ODD_LOT' } as EngineCommand);
    const triggered = ofType(out, 'engine.auction_triggered')[0];
    expect(triggered?.board).toBe('MAIN');
    expect(triggered?.payload['reason']).toBe('STATIC_BAND');
    expect(engine.phase).toBe('VOLATILITY_AUCTION');
  });
});

describe('trade bust (RN-BST-001..003)', () => {
  const setup = () => {
    const engine = new InstrumentEngine(INSTRUMENT);
    const feed = feeder(engine);
    feed({ kind: 'PhaseChange', phase: 'CONTINUOUS' });
    feed(order('S', 'SELL', 100, '10.00'));
    const out = feed(order('B', 'BUY', 100, '10.00'));
    const tradeId = ofType(out, 'engine.trade_executed')[0]!.payload['tradeId'] as string;
    return { engine, feed, tradeId };
  };
  const bust = (tradeId: string): EngineCommand => ({
    kind: 'TradeBust',
    tradeId,
    approvalRequestId: 'APR',
  });

  it('cancela uma vez só; as ordens não voltam ao livro', () => {
    const { engine, feed, tradeId } = setup();
    expect(ofType(feed(bust(tradeId)), 'engine.trade_busted')).toHaveLength(1);
    expect(engine.bookView('MAIN')).toEqual({ bids: [], asks: [] });
    expect(ofType(feed(bust(tradeId)), 'engine.trade_bust_rejected')[0]?.payload['reason']).toBe(
      'ALREADY_BUSTED',
    );
  });

  it('depois das notas é recusado', () => {
    const { feed, tradeId } = setup();
    feed({ kind: 'NotesCutoff', tradingDate: '2026-03-03' });
    expect(ofType(feed(bust(tradeId)), 'engine.trade_bust_rejected')[0]?.payload['reason']).toBe(
      'NOTES_ALREADY_GENERATED',
    );
  });

  it('outro pregão não encontra o negócio', () => {
    const { feed, tradeId } = setup();
    feed({ kind: 'PhaseChange', phase: 'CLOSED' });
    expect(ofType(feed(bust(tradeId)), 'engine.trade_bust_rejected')[0]?.payload['reason']).toBe(
      'TRADE_NOT_FOUND',
    );
  });
});

describe('fim do dia (RN-REC-005)', () => {
  it('alterar e cancelar uma GTC guardada; a aumentada perde a prioridade na volta', () => {
    const engine = new InstrumentEngine(INSTRUMENT);
    const feed = feeder(engine);
    const gtc = (id: string) =>
      ({ ...order(id, 'SELL', 100, '10.00'), timeInForce: 'GTC' }) as EngineCommand;
    feed({ kind: 'PhaseChange', phase: 'CONTINUOUS' });
    feed(gtc('G1'));
    feed(gtc('G2'));
    feed(gtc('G3'));
    feed({ kind: 'PhaseChange', phase: 'CLOSED' });
    feed({ kind: 'ReplaceOrder', orderId: 'G1', newQuantity: 200, expectedVersion: 1 });
    expect(
      ofType(
        feed({ kind: 'CancelOrder', orderId: 'G3', reason: 'EXPIRED' }),
        'engine.order_canceled',
      ),
    ).toHaveLength(1);
    const back = feed({ kind: 'PhaseChange', phase: 'PRE_OPENING', auctionId: 'L2' });
    expect(ofType(back, 'engine.order_booked').map((o) => o.payload['orderId'])).toEqual([
      'G2',
      'G1',
    ]);
    expect(engine.bookView('MAIN').asks[0]?.orders.map((o) => o.id)).toEqual(['G2', 'G1']);
  });

  it('o id de uma ordem do dia anterior pode voltar depois do fim do dia', () => {
    const engine = new InstrumentEngine(INSTRUMENT);
    const feed = feeder(engine);
    feed({ kind: 'PhaseChange', phase: 'CONTINUOUS' });
    feed(order('A', 'BUY', 100, '10.00'));
    expect(ofType(feed(order('A', 'BUY', 100, '10.00')), 'engine.order_rejected')).toHaveLength(1);
    feed({ kind: 'PhaseChange', phase: 'CLOSED' });
    feed({ kind: 'PhaseChange', phase: 'CONTINUOUS' });
    expect(ofType(feed(order('A', 'BUY', 100, '10.00')), 'engine.order_booked')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------- propriedades

/** Fluxo aleatório, mas fixo por semente, que passa por todas as fases e tipos de ordem. */
function randomInputs(seed: number, count: number): EngineInput[] {
  const random = seededRandom(seed);
  const inputs: EngineInput[] = [];
  let seq = 0;
  let now = START;
  let next = 0;
  let auction = 0;
  const ids: string[] = [];
  const push = (command: EngineCommand) =>
    inputs.push({
      inputSeq: ++seq,
      ts: (now += random.int(1, 2000)),
      tradingDate: '2026-03-03',
      seed: random.int(0, 2 ** 30),
      command,
    });
  push(bands());
  push({ kind: 'PhaseChange', phase: 'CONTINUOUS' });
  while (inputs.length < count) {
    const roll = random.next();
    const id = ids.length ? ids[random.int(0, ids.length - 1)]! : 'none';
    if (roll < 0.02) {
      auction++;
      push({
        kind: 'PhaseChange',
        phase: 'PRE_OPENING',
        auctionId: `L${auction}`,
        auctionEndAt: new Date(now + 1000).toISOString(),
        randomSeed: String(random.int(0, 1000)),
      });
    } else if (roll < 0.04) {
      push({ kind: 'PhaseChange', phase: 'CONTINUOUS', concludesAuctionId: `L${auction}` });
    } else if (roll < 0.05) {
      push({ kind: 'PhaseChange', phase: 'HALTED' });
    } else if (roll < 0.06) {
      push({ kind: 'PhaseChange', phase: 'CONTINUOUS' });
    } else if (roll < 0.07) {
      push({ kind: 'Tick' });
    } else if (roll < 0.075) {
      push({ kind: 'PhaseChange', phase: 'CLOSED' });
      push({ kind: 'PhaseChange', phase: 'CONTINUOUS' });
    } else if (roll < 0.25) {
      push({ kind: 'CancelOrder', orderId: id, reason: 'CUSTOMER_REQUEST' });
    } else if (roll < 0.35) {
      push({
        kind: 'ReplaceOrder',
        orderId: id,
        expectedVersion: 1,
        ...(random.next() < 0.5
          ? { newQuantity: 100 * random.int(1, 5) }
          : { newLimitPrice: (random.int(980, 1020) / 100).toFixed(2) }),
      });
    } else {
      const orderId = `O${++next}`;
      ids.push(orderId);
      const market = random.next() < 0.1;
      const tif = ['DAY', 'DAY', 'GTC', 'IOC', 'FOK'][random.int(0, 4)] as 'DAY';
      const quantity = 100 * random.int(1, 5);
      push({
        kind: 'NewOrder',
        orderId,
        accountId: `A${random.int(1, 6)}`,
        participantType: 'CUSTOMER',
        board: random.next() < 0.2 ? 'ODD_LOT' : 'MAIN',
        side: random.next() < 0.5 ? 'BUY' : 'SELL',
        type: market ? 'MARKET' : 'LIMIT',
        quantity,
        ...(market ? {} : { limitPrice: (random.int(980, 1020) / 100).toFixed(2) }),
        ...(market && random.next() < 0.5 ? { protectionPrice: '10.15' } : {}),
        timeInForce: tif,
        ...(random.next() < 0.1 ? { displayQuantity: 100 } : {}),
        stpPolicy: (['CANCEL_AGGRESSOR', 'CANCEL_RESTING', 'CANCEL_BOTH'] as const)[
          random.int(0, 2)
        ]!,
      });
    }
  }
  return inputs;
}

const CONTRACTS: Record<string, EventDefinition> = Object.fromEntries(
  [
    EngineAuctionCompletedV1,
    EngineAuctionIndicativeV1,
    EngineAuctionTriggeredV1,
    EngineBookChangedV1,
    EngineOrderBookedV1,
    EngineOrderCanceledV1,
    EngineOrderRejectedV1,
    EngineOrderReplacedV1,
    EngineTradeBustedV1,
    EngineTradeBustRejectedV1,
    EngineTradeExecutedV1,
  ].map((d) => [d.eventType, d]),
);

describe('propriedades do Motor', () => {
  it.each([1, 2, 3, 4, 5])(
    'determinismo: replay e snapshot em qualquer ponto dão saídas iguais (semente %i)',
    (seed) => {
      const inputs = randomInputs(seed, 1500);
      const original = new InstrumentEngine(INSTRUMENT);
      const outputs = inputs.flatMap((i) => original.process(i));

      const replayed = new InstrumentEngine(INSTRUMENT);
      expect(inputs.flatMap((i) => replayed.process(i))).toEqual(outputs);

      const cut = 300 + seed * 150;
      const before = new InstrumentEngine(INSTRUMENT);
      const head = inputs.slice(0, cut).flatMap((i) => before.process(i));
      const restored = InstrumentEngine.restore(JSON.parse(JSON.stringify(before.snapshot())));
      const tail = inputs.slice(cut).flatMap((i) => restored.process(i));
      expect([...head, ...tail]).toEqual(outputs);
      expect(restored.snapshot()).toEqual(original.snapshot());
    },
  );

  it.each([11, 12, 13])(
    'invariantes por livro: engine_seq contínuo, quantidade conservada, livro não cruza no contínuo (semente %i)',
    (seed) => {
      const inputs = randomInputs(seed, 2000);
      const engine = new InstrumentEngine(INSTRUMENT);
      const lastSeq: Record<string, number> = { MAIN: 0, ODD_LOT: 0 };
      const tradeIds = new Set<string>();
      for (const input of inputs) {
        for (const o of engine.process(input)) {
          expect(o.engineSeq).toBe(lastSeq[o.board]! + 1);
          lastSeq[o.board] = o.engineSeq;
          if (o.eventType === 'engine.trade_executed') {
            const id = o.payload['tradeId'] as string;
            expect(tradeIds.has(id)).toBe(false);
            tradeIds.add(id);
            expect(o.payload['buyAccountId']).not.toBe(o.payload['sellAccountId']); // RN-SLF-001
          }
        }
        // Compras do melhor para o pior, vendas idem.
        for (const board of ['MAIN', 'ODD_LOT'] as const) {
          const view = engine.bookView(board);
          for (const levels of [view.bids, view.asks])
            for (const level of levels) {
              expect(level.orders.length).toBeGreaterThan(0);
              for (const o of level.orders) expect(o.qty).toBeGreaterThan(0);
            }
        }
      }
      expect(tradeIds.size).toBeGreaterThan(0);
    },
  );

  it('toda saída obedece ao contrato publicado', () => {
    const uuid = (text: string) => {
      const known = ids.get(text) ?? uuidv7();
      ids.set(text, known);
      return known;
    };
    const ids = new Map<string, string>();
    const inputs = randomInputs(21, 3000).map((input) => {
      const c = input.command as unknown as Record<string, unknown>;
      const mapped = { ...c };
      for (const key of ['orderId', 'accountId', 'auctionId', 'concludesAuctionId'])
        if (typeof c[key] === 'string') mapped[key] = uuid(c[key]);
      return { ...input, command: mapped as unknown as EngineCommand };
    });
    const engine = new InstrumentEngine(INSTRUMENT);
    const seen = new Set<string>();
    for (const input of inputs)
      for (const o of engine.process(input)) {
        seen.add(o.eventType);
        const definition = CONTRACTS[o.eventType];
        expect(definition, o.eventType).toBeDefined();
        expect(validationErrors(definition!.payload, o.payload), o.eventType).toEqual([]);
      }
    expect(seen).toContain('engine.trade_executed');
    expect(seen).toContain('engine.auction_completed');
    expect(seen).toContain('engine.book_changed');
  });
});

describe('comandos do barramento', () => {
  const envelope = (eventType: string, payload: Record<string, unknown>, eventVersion = 1) =>
    ({ eventType, eventVersion, payload }) as unknown as Envelope;
  const base = {
    instrumentId: INSTRUMENT,
    orderId: uuidv7(),
    accountId: uuidv7(),
    participantType: 'CUSTOMER',
    board: 'MAIN',
    side: 'BUY',
    quantity: 100,
    timeInForce: 'DAY',
    stpPolicy: 'CANCEL_AGGRESSOR',
  };

  it('traduz para o domínio', () => {
    const decoded = decodeCommand(
      envelope('engine.new_order', { ...base, type: 'LIMIT', limitPrice: '10.00' }),
    );
    expect(decoded?.instrumentId).toBe(INSTRUMENT);
    expect(decoded?.command).toMatchObject({ kind: 'NewOrder', limitPrice: '10.00' });
    expect(decoded?.command).not.toHaveProperty('instrumentId');
    expect(
      decodeCommand(envelope('engine.phase_change', { scope: INSTRUMENT, phase: 'HALTED' })),
    ).toEqual({ instrumentId: INSTRUMENT, command: { kind: 'PhaseChange', phase: 'HALTED' } });
  });

  it('tipo ou versão desconhecidos são ignorados (RN-MSG-B-021)', () => {
    expect(decodeCommand(envelope('engine.outra_coisa', {}))).toBeNull();
    expect(decodeCommand(envelope('engine.new_order', {}, 99))).toBeNull();
  });

  it('o que o livro não saberia processar nem chega ao journal', () => {
    const bad = (extra: Record<string, unknown>) =>
      decodeCommand(envelope('engine.new_order', { ...base, ...extra }));
    expect(() => bad({ type: 'LIMIT' })).toThrow(InvalidCommandError);
    expect(() => bad({ type: 'MARKET', limitPrice: '10.00' })).toThrow(InvalidCommandError);
    expect(() => bad({ type: 'LIMIT', limitPrice: '0.00' })).toThrow(InvalidCommandError);
    expect(() => bad({ type: 'LIMIT', limitPrice: '10.00', displayQuantity: 500 })).toThrow(
      InvalidCommandError,
    );
    expect(() => bad({ type: 'LIMIT', limitPrice: '10.00', quantity: 0 })).toThrow(
      InvalidCommandError,
    );
  });
});
