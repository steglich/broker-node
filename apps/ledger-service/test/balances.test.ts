// 15.3 saldos (settled, projected(Dn), total, withdrawable) com as_of e os eventos de saldo.
import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
import { uuidv7 } from '@broker/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { settlementDays } from '../src/domain/balances.js';
import { customerCash, houseAccount } from '../src/domain/chart.js';
import {
  app,
  balancesOf,
  bearer,
  brl,
  customerToken,
  deposit,
  openClient,
  outbox,
  startEnv,
  stopEnv,
  type App,
  type Env,
} from './helpers.js';

const calendar = new TradingCalendar(b3Calendar2026To2027);
let env: Env;
let a: App;
beforeAll(async () => {
  env = await startEnv();
  a = await app(env);
}, 180_000);
afterAll(() => stopEnv(env));

/** Negócio em D0 com liquidação em D2 contra a câmara (Financeiro §9). */
async function trade(accountId: string, side: 'BUY' | 'SELL', amount: string) {
  const today = a.clock.now().businessDate();
  const d2 = settlementDays(calendar, today).d2;
  const id = uuidv7();
  return a.store.transaction((tx) =>
    a.ledger.post(tx, {
      idempotencyKey: `trade:${id}:${side === 'BUY' ? 'buyer' : 'seller'}`,
      type: 'TRADE',
      referenceType: 'TRADE_ALLOCATION',
      referenceId: id,
      description: side === 'BUY' ? 'Compra PETR4' : 'Venda VALE3',
      bookingDate: today,
      createdBy: 'test',
      lines: [
        {
          account: customerCash(accountId),
          side: side === 'BUY' ? 'DEBIT' : 'CREDIT',
          amount: brl(amount),
          valueDate: d2,
          status: 'PENDING',
        },
        {
          account: houseAccount('CLEARING_HOUSE'),
          side: side === 'BUY' ? 'CREDIT' : 'DEBIT',
          amount: brl(amount),
          valueDate: d2,
          status: 'PENDING',
        },
      ],
    }),
  );
}

describe('15.3 saldos (Financeiro §4, RN-LED-020/021)', () => {
  it('LED-001: R$ 10.000 liquidados, compra 6.000 e venda 3.000 em D2 → projetado D2 e sacável 7.000', async () => {
    const c = await openClient(a);
    await deposit(a, c, '10000.00');
    await trade(c.accountId, 'BUY', '6000.00');
    a.clock.advanceBy(60_000);
    await trade(c.accountId, 'SELL', '3000.00');

    const b = await balancesOf(a, c);
    expect(b).toMatchObject({
      settled: '10000.00',
      projected: { d0: '10000.00', d1: '10000.00', d2: '7000.00' },
      projectedTotal: '7000.00',
      withdrawable: '7000.00',
      holds: '0.00',
      lastSequence: 3,
    });
    // RN-LED-021: as_of é o instante da última entrada considerada.
    expect(b.asOf).toBe(a.clock.now().toString());

    const last = (await outbox(env.db, 'ledger.balance_changed'))
      .filter((e) => e.payload['accountId'] === c.accountId)
      .at(-1)!;
    expect(last).toMatchObject({
      partition_key: c.accountId,
      payload: {
        settled: '10000.00',
        projected: { d2: '7000.00' },
        withdrawable: '7000.00',
        lastSequence: 3,
      },
    });
  });

  it('uma conta que ainda não chegou ao ledger responde 404; outro usuário vê só a própria conta', async () => {
    const stranger = await customerToken(a.clock, uuidv7(), uuidv7());
    await a.http.get('/v1/me/balances').set(bearer(stranger)).expect(404);
    const noAccount = await customerToken(a.clock, uuidv7());
    await a.http.get('/v1/me/balances').set(bearer(noAccount)).expect(404);
  });
});
