import { uuidv7 } from '@broker/ids';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  app,
  clearOutbox,
  commands,
  engineAcks,
  inst,
  instrument,
  outbox,
  phase,
  plusMinutes,
  reference,
  reset,
  startEnv,
  stopEnv,
  trade,
  type App,
  type Env,
} from './helpers.js';

let env: Env;
let a: App;
beforeAll(async () => {
  env = await startEnv();
}, 180_000);
afterAll(() => stopEnv(env));
beforeEach(async () => {
  await reset(env.db);
  a = await app(env);
});

const FULL_ORDERS = 12; // 5 níveis e 1 fracionário por lado
const instant = () => a.clock.now();

describe('conta e ativação do FMS (RN-SMM-020..022)', () => {
  it('RN-SMM-020: ao entrar no universo, publica o estoque inicial uma vez só', async () => {
    const id = await instrument(a);
    const [row] = await outbox(env.db, 'smm.instrument_activated');
    expect(row!.payload).toMatchObject({
      instrumentId: id,
      symbol: 'PETR4',
      accountId: a.accountId,
      initialStock: 2000 * 100,
    });
    await a.store.transaction((tx) =>
      a.maker.onTradabilityChanged(tx, {
        instrumentId: id,
        symbol: 'PETR4',
        lotSize: 100,
        tradable: false,
      }),
    );
    await a.store.transaction((tx) =>
      a.maker.onTradabilityChanged(tx, {
        instrumentId: id,
        symbol: 'PETR4',
        lotSize: 100,
        tradable: true,
      }),
    );
    expect(await outbox(env.db, 'smm.instrument_activated')).toHaveLength(1);
  });

  it('não ativa instrumento fora do universo', async () => {
    const id = uuidv7();
    await a.store.transaction((tx) =>
      a.maker.onInstrumentState(tx, {
        instrumentId: id,
        symbol: 'VALE3',
        lotSize: 100,
        tickSize: '0.01',
        oddLotEnabled: true,
        tradable: false,
        status: 'ACTIVE',
      }),
    );
    expect(await outbox(env.db, 'smm.instrument_activated')).toEqual([]);
  });

  it('RN-SMM-022: as ordens saem pela conta MARKET_MAKER, direto para o Motor', async () => {
    await instrument(a, { phase: 'CONTINUOUS' });
    const { newOrders } = await commands(env.db);
    expect(newOrders).toHaveLength(FULL_ORDERS);
    for (const o of newOrders) {
      expect(o.participantType).toBe('MARKET_MAKER');
      expect(o.accountId).toBe(a.accountId);
      expect(o.timeInForce).toBe('DAY');
    }
  });

  it('a ordem entre tópicos não importa: preço antes do cadastro ainda vira cotação', async () => {
    const id = uuidv7();
    await phase(a, 'MARKET', 'CONTINUOUS');
    await reference(a, id, '38.5000', 1);
    expect((await commands(env.db)).newOrders).toEqual([]);
    await a.store.transaction((tx) =>
      a.maker.onInstrumentState(tx, {
        instrumentId: id,
        symbol: 'PETR4',
        lotSize: 100,
        tickSize: '0.01',
        oddLotEnabled: true,
        tradable: true,
        status: 'ACTIVE',
      }),
    );
    expect((await commands(env.db)).newOrders).toHaveLength(FULL_ORDERS);
  });
});

describe('comportamento por fase (Motor §6.6)', () => {
  it('PRE_TRADING calcula sem enviar', async () => {
    const id = await instrument(a, { phase: 'PRE_TRADING' });
    expect((await commands(env.db)).newOrders).toEqual([]);
    const s = await inst(a, id);
    expect(s.bestBid?.toFixed()).toBe('38.48');
    expect(s.liveOrders).toEqual([]);
  });

  it.each(['PRE_OPENING', 'CLOSING_CALL', 'VOLATILITY_AUCTION'] as const)(
    '%s: um nível por lado em ref ± meio-spread',
    async (p) => {
      await instrument(a, { phase: p });
      const { newOrders } = await commands(env.db);
      expect(newOrders.map((o) => [o.side, o.limitPrice, o.quantity, o.board])).toEqual([
        ['BUY', '38.48', 1000, 'MAIN'],
        ['SELL', '38.52', 1000, 'MAIN'],
      ]);
    },
  );

  it('CONTINUOUS cota completo; ao voltar do leilão, só o que falta entra', async () => {
    const id = await instrument(a, { phase: 'PRE_OPENING' });
    await engineAcks(a, id);
    await clearOutbox(env.db);
    await phase(a, 'MARKET', 'CONTINUOUS');
    const { newOrders, cancels } = await commands(env.db);
    expect(cancels).toEqual([]);
    expect(newOrders).toHaveLength(FULL_ORDERS - 2);
  });

  it('do contínuo para o leilão, os demais níveis são cancelados', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    await clearOutbox(env.db);
    await phase(a, id, 'VOLATILITY_AUCTION');
    const { newOrders, cancels } = await commands(env.db);
    expect(cancels).toHaveLength(FULL_ORDERS - 2);
    expect(newOrders).toEqual([]);
  });

  it.each(['HALTED', 'POST_CLOSE', 'CLOSED'] as const)(
    '%s: cancela todas as ofertas e não envia nada',
    async (p) => {
      const id = await instrument(a, { phase: 'CONTINUOUS' });
      await engineAcks(a, id);
      await clearOutbox(env.db);
      await phase(a, 'MARKET', p);
      const { newOrders, cancels } = await commands(env.db);
      expect(cancels).toHaveLength(FULL_ORDERS);
      expect(newOrders).toEqual([]);
    },
  );

  it('suspensão do instrumento cancela só as dele, e a retomada volta a cotar', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    await clearOutbox(env.db);
    await phase(a, id, 'HALTED');
    expect((await commands(env.db)).cancels).toHaveLength(FULL_ORDERS);
    expect((await inst(a, id)).ownPhase).toBe('HALTED');

    await engineAcks(a, id);
    expect((await inst(a, id)).liveOrders).toEqual([]);
    await clearOutbox(env.db);
    await phase(a, id, 'CONTINUOUS');
    expect((await commands(env.db)).newOrders).toHaveLength(FULL_ORDERS);
    expect((await inst(a, id)).ownPhase).toBeNull();
  });

  it('RN-SES-001: instrumento suspenso continua sem cotar quando o mercado muda', async () => {
    const id = await instrument(a, { phase: 'PRE_OPENING' });
    await engineAcks(a, id);
    await phase(a, id, 'HALTED');
    await engineAcks(a, id);
    await clearOutbox(env.db);
    await phase(a, 'MARKET', 'CONTINUOUS');
    expect((await commands(env.db)).newOrders).toEqual([]);
  });

  it('o aviso atrasado de retomada não faz cotar no fim do dia', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    await phase(a, 'MARKET', 'POST_CLOSE');
    await engineAcks(a, id);
    await clearOutbox(env.db);
    await phase(a, id, 'CONTINUOUS');
    expect((await commands(env.db)).newOrders).toEqual([]);
  });
});

describe('recotação (RN-SMM-010/011)', () => {
  it('(a) só recota quando a referência anda mais que o limiar', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    await clearOutbox(env.db);

    await reference(a, id, '38.5100', 2); // exatamente 1 tick: não passa do limiar
    expect((await commands(env.db)).order).toEqual([]);

    await reference(a, id, '38.6000', 3);
    const { cancels, newOrders, order } = await commands(env.db);
    expect(cancels.length).toBeGreaterThan(0);
    expect(newOrders.length).toBe(cancels.length);
    // RN-SMM-011: os cancelamentos vão antes das novas ordens.
    expect(order.lastIndexOf('engine.cancel_order')).toBeLessThan(
      order.indexOf('engine.new_order'),
    );
  });

  it('descarta referência já vista', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await reference(a, id, '40.0000', 1);
    expect((await inst(a, id)).reference?.toFixed()).toBe('38.5');
  });

  it('(b) nível de venda totalmente executado volta com ordem nova', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    const level1 = (await inst(a, id)).liveOrders.find(
      (o) => o.board === 'MAIN' && o.side === 'SELL' && o.price === '38.52',
    )!;
    await clearOutbox(env.db);
    await trade(a, {
      instrumentId: id,
      orderId: level1.orderId,
      side: 'SELL',
      price: '38.52',
      quantity: level1.remaining,
    });
    const s = await inst(a, id);
    expect(s.position.inventory).toBe(-1000);
    const { newOrders } = await commands(env.db);
    expect(newOrders.some((o) => o.side === 'SELL' && o.limitPrice === '38.52')).toBe(true);
    expect(s.liveOrders.some((o) => o.orderId === level1.orderId)).toBe(false);
  });

  it('execução parcial atualiza o inventário sem recotar', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    const o = (await inst(a, id)).liveOrders.find((l) => l.side === 'BUY' && l.board === 'MAIN')!;
    await clearOutbox(env.db);
    await trade(a, {
      instrumentId: id,
      orderId: o.orderId,
      side: 'BUY',
      price: o.price,
      quantity: 100,
    });
    const s = await inst(a, id);
    expect(s.position.inventory).toBe(100);
    expect(s.liveOrders.find((l) => l.orderId === o.orderId)!.remaining).toBe(o.remaining - 100);
    expect((await commands(env.db)).order).toEqual([]);
  });

  it('negócio repetido conta uma vez; negócio de clientes não mexe no FMS', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    const o = (await inst(a, id)).liveOrders.find((l) => l.side === 'BUY' && l.board === 'MAIN')!;
    const fill = {
      instrumentId: id,
      orderId: o.orderId,
      side: 'BUY' as const,
      price: o.price,
      quantity: 100,
    };
    const tradeId = await trade(a, fill);
    await trade(a, { ...fill, tradeId });
    expect((await inst(a, id)).position.inventory).toBe(100);

    await a.store.transaction((tx) =>
      a.maker.onTradeExecuted(tx, {
        instrumentId: id,
        engineSeq: 9_999,
        tradeId: uuidv7(),
        price: '38.50',
        quantity: 100,
        buyOrderId: uuidv7(),
        sellOrderId: uuidv7(),
        buyAccountId: uuidv7(),
        sellAccountId: uuidv7(),
        buyParticipantType: 'CUSTOMER',
        sellParticipantType: 'CUSTOMER',
        executedAt: instant().toString(),
      }),
    );
    expect((await inst(a, id)).position.volume).toBe(100);
  });

  it('(d) a manutenção respeita o intervalo e repõe o que o Motor recusou', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    const rejected = (await inst(a, id)).liveOrders[0]!;
    await a.store.transaction((tx) =>
      a.maker.onOrderGone(tx, { instrumentId: id, orderId: rejected.orderId }),
    );
    await clearOutbox(env.db);

    a.clock.advanceBy(30_000);
    await a.maker.tick();
    expect((await commands(env.db)).newOrders).toEqual([]);

    a.clock.advanceBy(30_000);
    await a.maker.tick();
    const { newOrders } = await commands(env.db);
    expect(newOrders.map((o) => o.limitPrice)).toEqual([rejected.price]);
    expect(await outbox(env.db, 'smm.metrics')).toHaveLength(1);
  });

  it('RN-BST-002: trade bust desfaz o inventário e o resultado', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    const buy = (await inst(a, id)).liveOrders.find((l) => l.side === 'BUY' && l.board === 'MAIN')!;
    const sell = (await inst(a, id)).liveOrders.find(
      (l) => l.side === 'SELL' && l.board === 'MAIN',
    )!;
    const first = await trade(a, {
      instrumentId: id,
      orderId: buy.orderId,
      side: 'BUY',
      price: '38.48',
      quantity: 100,
    });
    await trade(a, {
      instrumentId: id,
      orderId: sell.orderId,
      side: 'SELL',
      price: '38.52',
      quantity: 100,
    });
    expect((await inst(a, id)).position.realizedPnl.toFixed()).toBe('4');

    await a.store.transaction((tx) =>
      a.maker.onTradeBusted(tx, { instrumentId: id, tradeId: first }),
    );
    const { position } = await inst(a, id);
    expect(position.inventory).toBe(-100);
    expect(position.realizedPnl.toFixed()).toBe('0');
    expect(position.volume).toBe(100);
  });
});

describe('limite de inventário e túnel (RN-SMM-001/002)', () => {
  const setInventory = (id: string, inventory: number) =>
    sql`UPDATE smm_state SET inventory = ${inventory} WHERE instrument_id = ${id}`.execute(env.db);

  it('com o inventário no limite comprado, não mantém nenhuma oferta de compra', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    await setInventory(id, 200_000);
    await clearOutbox(env.db);
    await reference(a, id, '39.0000', 2);
    const s = await inst(a, id);
    const buys = s.liveOrders.filter((o) => o.side === 'BUY');
    expect(buys.every((o) => o.status === 'CANCELING')).toBe(true);
    expect((await commands(env.db)).newOrders.filter((o) => o.side === 'BUY')).toEqual([]);
  });

  it('subir o limite depois da ativação não passa do estoque emitido (RN-SMM-021)', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    await setInventory(id, -200_000);
    await a.store.transaction((tx) =>
      tx.insertParams({
        id: uuidv7(),
        instrumentId: id,
        params: { inventoryLimitLots: 5000 },
        validFrom: instant(),
        approvalRequestId: null,
      }),
    );
    await clearOutbox(env.db);
    await reference(a, id, '39.0000', 2);
    expect((await commands(env.db)).newOrders.filter((o) => o.side === 'SELL')).toEqual([]);
  });

  it('RN-SMM-002: respeita o túnel do BandUpdate e o que o leilão moveu', async () => {
    const id = await instrument(a, { phase: 'PRE_TRADING' });
    await a.store.transaction((tx) =>
      a.maker.onBandUpdate(tx, {
        instrumentId: id,
        bandReferencePrice: '38.50',
        rejectionBandPct: '0.001',
      }),
    );
    await phase(a, 'MARKET', 'CONTINUOUS');
    const { newOrders } = await commands(env.db);
    const prices = newOrders.map((o) => Number(o.limitPrice));
    expect(Math.min(...prices)).toBeGreaterThanOrEqual(38.4615);
    expect(Math.max(...prices)).toBeLessThanOrEqual(38.5385);

    await a.store.transaction((tx) =>
      a.maker.onAuctionCompleted(tx, { instrumentId: id, board: 'MAIN', price: '39.00' }),
    );
    expect((await inst(a, id)).bandReference?.toFixed()).toBe('39');
  });

  it('usa o spread do reference-data, por vigência', async () => {
    await instrument(a, { phase: 'PRE_TRADING' });
    await a.store.transaction((tx) =>
      a.maker.onTradingRulesChanged(tx, {
        ruleId: uuidv7(),
        instrumentId: null,
        rules: { smmSpreadBps: 100 },
        validFrom: instant(),
      }),
    );
    await phase(a, 'MARKET', 'PRE_OPENING');
    const { newOrders } = await commands(env.db);
    expect(newOrders.map((o) => o.limitPrice)).toEqual(['38.3', '38.7']);
  });
});

describe('varredura de ordens esquecidas (RN-SMM-012)', () => {
  const book = (
    id: string,
    side: 'BUY' | 'SELL',
    price: string,
    newQuantity: number,
    engineSeq: number,
  ) =>
    a.store.transaction((tx) =>
      a.maker.onBookChanged(tx, {
        instrumentId: id,
        board: 'MAIN',
        engineSeq,
        side,
        price,
        newQuantity,
      }),
    );

  it('a referência sobe acima de venda de cliente: compra até o limite, por IOC', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    // 38,61 não é preço de nenhum nível do FMS, que tem 5000 em 38,60.
    await book(id, 'SELL', '38.61', 8000, 100);
    await clearOutbox(env.db);

    await reference(a, id, '39.0000', 2);
    const { newOrders } = await commands(env.db);
    const sweep = newOrders.find((o) => o.timeInForce === 'IOC')!;
    expect(sweep).toMatchObject({ side: 'BUY', quantity: 5000, limitPrice: '38.98' });
    // Sobram 3000 a 38,61: nenhuma compra em repouso pode ficar nesse preço ou acima.
    const resting = newOrders.filter(
      (o) => o.timeInForce === 'DAY' && o.side === 'BUY' && o.board === 'MAIN',
    );
    expect(resting).toEqual([]);
  });

  it('as ofertas do próprio FMS no nível não contam como cliente', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    const own = (await inst(a, id)).liveOrders.find(
      (o) => o.board === 'MAIN' && o.side === 'SELL' && o.price === '38.52',
    )!;
    await book(id, 'SELL', '38.52', own.remaining + 300, 100);
    await clearOutbox(env.db);

    await reference(a, id, '39.0000', 2);
    const sweep = (await commands(env.db)).newOrders.find((o) => o.timeInForce === 'IOC')!;
    expect(sweep.quantity).toBe(300);
  });

  it('a execução da varredura não dispara outra recotação no mesmo instante', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    await book(id, 'SELL', '38.61', 300, 100);
    await reference(a, id, '39.0000', 2);
    const sweep = (await commands(env.db)).newOrders.find((o) => o.timeInForce === 'IOC')!;
    await clearOutbox(env.db);
    await trade(a, {
      instrumentId: id,
      orderId: sweep.orderId,
      side: 'BUY',
      price: '38.61',
      quantity: 300,
    });
    expect((await commands(env.db)).order).toEqual([]);
    expect((await inst(a, id)).position.inventory).toBe(300);
  });

  it('delta do livro repetido ou antigo é ignorado; nível zerado sai', async () => {
    const id = await instrument(a, { phase: 'PRE_TRADING' });
    await book(id, 'SELL', '38.60', 500, 10);
    await book(id, 'SELL', '38.60', 900, 9);
    let levels = await a.store.transaction((tx) => tx.bookLevels(id));
    expect(levels.map((l) => l.quantity)).toEqual([500]);
    await book(id, 'SELL', '38.60', 0, 11);
    levels = await a.store.transaction((tx) => tx.bookLevels(id));
    expect(levels).toEqual([]);
  });

  it('em leilão não há varredura: o livro pode cruzar', async () => {
    const id = await instrument(a, { phase: 'PRE_OPENING' });
    await book(id, 'SELL', '38.00', 500, 100);
    await clearOutbox(env.db);
    await reference(a, id, '39.0000', 2);
    expect((await commands(env.db)).newOrders.every((o) => o.timeInForce === 'DAY')).toBe(true);
  });
});

describe('referência defasada (RN-SMM-032)', () => {
  const hour = 3_600_000;
  const declareStale = async (id: string) => {
    await a.store.transaction((tx) =>
      a.maker.onInstrumentStale(tx, {
        instrumentId: id,
        staleSince: plusMinutes(instant(), -45),
        declaredAt: instant(),
      }),
    );
  };

  it('após 3 h o spread é ×8; na 4ª hora cancela tudo e avisa que parou', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    await declareStale(id);
    await clearOutbox(env.db);

    a.clock.advanceBy(3 * hour);
    await a.maker.tick();
    let s = await inst(a, id);
    expect(s.spreadMultiplier).toBe(8);
    const placed = (await commands(env.db)).newOrders;
    expect(placed.find((o) => o.side === 'BUY' && o.board === 'MAIN')!.limitPrice).toBe('38.34');
    expect(placed.find((o) => o.side === 'SELL' && o.board === 'MAIN')!.limitPrice).toBe('38.66');
    await engineAcks(a, id);
    await clearOutbox(env.db);

    a.clock.advanceBy(hour);
    await a.maker.tick();
    s = await inst(a, id);
    expect(s.stopped).toBe(true);
    const after = await commands(env.db);
    expect(after.newOrders).toEqual([]);
    expect(after.cancels.length).toBeGreaterThan(0);
    const [status] = await outbox(env.db, 'smm.status_changed');
    expect(status!.payload).toMatchObject({ scope: id, status: 'STOPPED' });
  });

  it('o ruído não encerra a defasagem; a cotação externa nova, sim', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    await declareStale(id);
    a.clock.advanceBy(4 * hour);
    await a.maker.tick();
    await engineAcks(a, id);
    await clearOutbox(env.db);

    await reference(a, id, '38.9000', 2, null);
    expect((await inst(a, id)).stopped).toBe(true);
    expect((await commands(env.db)).newOrders).toEqual([]);

    await reference(a, id, '38.9500', 3, instant());
    const s = await inst(a, id);
    expect(s.stopped).toBe(false);
    expect(s.spreadMultiplier).toBe(1);
    expect((await commands(env.db)).newOrders).toHaveLength(FULL_ORDERS);
    const statuses = await outbox(env.db, 'smm.status_changed');
    expect(statuses.at(-1)!.payload).toMatchObject({ status: 'ON' });
  });
});

describe('métricas (RN-SMM-031)', () => {
  it('publica inventário, P&L, volume, recotações, spread efetivo e tempo cotado', async () => {
    const id = await instrument(a, { phase: 'CONTINUOUS' });
    await engineAcks(a, id);
    const buy = (await inst(a, id)).liveOrders.find((l) => l.side === 'BUY' && l.board === 'MAIN')!;
    await trade(a, {
      instrumentId: id,
      orderId: buy.orderId,
      side: 'BUY',
      price: '38.48',
      quantity: 100,
    });
    a.clock.advanceBy(60_000);
    await a.maker.tick();
    const [row] = await outbox(env.db, 'smm.metrics');
    expect(row!.payload).toMatchObject({
      instrumentId: id,
      inventory: 100,
      realizedPnl: '0',
      unrealizedPnl: '2',
      volume: 100,
      quotedSeconds: 60,
    });
    const p = row!.payload as { requotes: number; effectiveSpreadBps: string };
    expect(p.requotes).toBeGreaterThanOrEqual(2);
    expect(Number(p.effectiveSpreadBps)).toBeGreaterThan(0);
  });
});
