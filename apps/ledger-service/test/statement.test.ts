// 15.6 extrato (filtros, cursor, saldo após, futuros) e reconciliação PIX diária; pendências de
// encerramento. Banco próprio: a reconciliação olha a reserva PIX inteira.
import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
import { BusinessDate } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerCash, houseAccount } from '../src/domain/chart.js';
import {
  app,
  backofficeToken,
  bearer,
  brl,
  deposit,
  openClient,
  randomCpf,
  serviceToken,
  signatureToken,
  startEnv,
  stopEnv,
  webhook,
  type App,
  type Client,
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

async function trade(c: Client, side: 'BUY' | 'SELL', amount: string, businessDays: number) {
  const today = a.clock.now().businessDate();
  const valueDate = calendar.nextBusinessDay(today, businessDays);
  const id = uuidv7();
  await a.store.transaction((tx) =>
    a.ledger.post(tx, {
      idempotencyKey: `trade:${id}:${side}`,
      type: 'TRADE',
      referenceType: 'TRADE_ALLOCATION',
      referenceId: id,
      description: side === 'BUY' ? 'Compra PETR4' : 'Venda VALE3',
      bookingDate: today,
      createdBy: 'test',
      lines: [
        {
          account: customerCash(c.accountId),
          side: side === 'BUY' ? 'DEBIT' : 'CREDIT',
          amount: brl(amount),
          valueDate,
          status: 'PENDING',
        },
        {
          account: houseAccount('CLEARING_HOUSE'),
          side: side === 'BUY' ? 'CREDIT' : 'DEBIT',
          amount: brl(amount),
          valueDate,
          status: 'PENDING',
        },
      ],
    }),
  );
}

async function withdraw(c: Client, amount: string) {
  const id = uuidv7();
  a.customers.destinations.set(id, {
    id,
    accountId: c.accountId,
    status: 'ACTIVE',
    pixKey: c.taxId,
    availableFrom: a.clock.now().plusMillis(-48 * 3_600_000),
    holderTaxId: c.taxId,
  });
  await a.http
    .post('/v1/me/withdrawals')
    .set(bearer(c.token))
    .set('Idempotency-Key', uuidv7())
    .set('X-Trading-Signature', await signatureToken(a.clock, c.userId, 'WITHDRAWALS'))
    .send({ amount, bankAccountId: id })
    .expect(202);
  await a.withdrawals.processDue();
}

const statement = async (c: Client, query: Record<string, string> = {}) =>
  (await a.http.get('/v1/me/statement').query(query).set(bearer(c.token)).expect(200)).body as {
    items: {
      category: string;
      amount: string;
      status: string;
      balanceAfter: string;
      sequence: number;
      valueDate: string;
      description: string;
    }[];
    nextCursor?: string;
  };

describe('15.6 extrato (RN-EXT-001/002/004)', () => {
  let c: Client;
  beforeAll(async () => {
    c = await openClient(a);
    await deposit(a, c, '1000.00');
    await withdraw(c, '200.00');
    await trade(c, 'BUY', '300.00', 2);
    await trade(c, 'SELL', '50.00', 3);
  });

  it('do mais recente ao mais antigo, com valor com sinal, status e saldo após cada lançamento', async () => {
    const s = await statement(c);
    expect(s.items.map((i) => [i.category, i.amount, i.status, i.balanceAfter])).toEqual([
      ['TRADE', '50.00', 'PENDING', '550.00'],
      ['TRADE', '-300.00', 'PENDING', '500.00'],
      ['WITHDRAWAL', '-200.00', 'SETTLED', '800.00'],
      ['DEPOSIT', '1000.00', 'SETTLED', '1000.00'],
    ]);
    expect(s.items[2]!.description).toBe('Saque via PIX');
    expect(s.nextCursor).toBeUndefined();
  });

  it('filtros por tipo e status não mudam o saldo após; o cursor pagina sem repetir', async () => {
    expect(
      (await statement(c, { type: 'DEPOSIT,WITHDRAWAL' })).items.map((i) => i.balanceAfter),
    ).toEqual(['800.00', '1000.00']);
    expect((await statement(c, { status: 'PENDING' })).items).toHaveLength(2);
    const today = a.clock.now().businessDate().toString();
    expect((await statement(c, { from: today, to: today })).items).toHaveLength(4);
    expect((await statement(c, { from: '2025-01-01', to: '2025-12-31' })).items).toHaveLength(0);
    const page1 = await statement(c, { limit: '3' });
    expect(page1.items).toHaveLength(3);
    const page2 = await statement(c, { limit: '3', cursor: page1.nextCursor! });
    expect(page2.items.map((i) => i.category)).toEqual(['DEPOSIT']);
    expect(page2.nextCursor).toBeUndefined();
    await a.http.get('/v1/me/statement').query({ type: 'XPTO' }).set(bearer(c.token)).expect(400);
  });

  it('lançamentos futuros agrupados por data-valor', async () => {
    const today = a.clock.now().businessDate();
    const body = (await a.http.get('/v1/me/statement/future').set(bearer(c.token)).expect(200))
      .body;
    expect(
      body.groups.map((g: { valueDate: string; total: string }) => [g.valueDate, g.total]),
    ).toEqual([
      [calendar.nextBusinessDay(today, 2).toString(), '-300.00'],
      [calendar.nextBusinessDay(today, 3).toString(), '50.00'],
    ]);
  });

  it('pendências de encerramento (RN-ACC-012): saldo e lançamentos a liquidar; conta zerada não tem', async () => {
    const token = await serviceToken(a.clock, ['closure:read']);
    const res = await a.http
      .get(`/v1/internal/accounts/${c.accountId}/closure-pendencies`)
      .set(bearer(token))
      .expect(200);
    expect(res.body.pendencies.map((p: { code: string }) => p.code).sort()).toEqual([
      'BALANCE_NOT_ZERO',
      'PENDING_ENTRIES',
    ]);
    const empty = await openClient(a);
    const none = await a.http
      .get(`/v1/internal/accounts/${empty.accountId}/closure-pendencies`)
      .set(bearer(token))
      .expect(200);
    expect(none.body.pendencies).toEqual([]);
    await a.http
      .get(`/v1/internal/accounts/${empty.accountId}/closure-pendencies`)
      .set(bearer(await serviceToken(a.clock, ['customer:eligibility'])))
      .expect(403);
  });
});

describe('15.6 reconciliação PIX diária (RN-PIXS-002)', () => {
  it('depósitos, devolução e saque batem com o Banco Simulado: OK, sem alerta', async () => {
    const c = await openClient(a);
    await deposit(a, c, '400.00');
    const res = await a.http
      .post('/v1/me/deposits')
      .set(bearer(c.token))
      .set('Idempotency-Key', uuidv7())
      .send({ amount: '30.00' })
      .expect(201);
    await webhook(a, a.pix.pay(res.body.id.replaceAll('-', ''), randomCpf())).expect(204);
    await withdraw(c, '100.00');
    a.clock.advanceBy(10 * 60_000);

    const rec = await a.reconciliation.run(a.clock.now().businessDate());
    expect(rec.divergences).toEqual([]);
    expect(rec).toMatchObject({ status: 'OK' });
    expect(rec.checked).toBeGreaterThanOrEqual(5);
    expect(a.alerts).toHaveLength(0);
    // A mesma data de novo devolve a mesma execução (rotina idempotente).
    expect((await a.reconciliation.run(a.clock.now().businessDate())).id).toBe(rec.id);
  });

  it('PIX confirmado no simulador sem lançamento → DIVERGENT e alerta crítico; consulta no backoffice', async () => {
    a.clock.advanceTo(BusinessDate.parse('2026-01-06').atLocalTime('23:15'));
    const orphan = {
      endToEndId: `ESIM20260106120000${'z'.repeat(14)}`,
      kind: 'CHARGE_PAYMENT' as const,
      completed: true,
      amount: brl('77.00'),
      at: BusinessDate.parse('2026-01-06').atLocalTime('12:00'),
      refunds: [],
    };
    a.pix.txs.push(orphan);
    const rec = await a.reconciliation.run(BusinessDate.parse('2026-01-06'));
    expect(rec.status).toBe('DIVERGENT');
    expect(rec.divergences).toEqual([
      expect.objectContaining({ kind: 'PIX_WITHOUT_LEDGER', endToEndId: orphan.endToEndId }),
    ]);
    expect(a.alerts).toEqual([
      expect.objectContaining({
        kind: 'PIX_RECONCILIATION_DIVERGENCE',
        businessDate: '2026-01-06',
      }),
    ]);
    const bo = await a.http
      .get('/v1/bo/reconciliations/pix/2026-01-06')
      .set(bearer(await backofficeToken(a.clock, ['BO_FINANCE'])))
      .expect(200);
    expect(bo.body).toMatchObject({ status: 'DIVERGENT', checked: 1 });
    // A janela continua de onde a anterior parou (sem buraco entre as execuções).
    const previous = (await a.store.transaction((tx) =>
      tx.reconciliation(BusinessDate.parse('2026-01-05')),
    ))!;
    expect(rec.periodFrom.equals(previous.periodTo)).toBe(true);
  });
});
