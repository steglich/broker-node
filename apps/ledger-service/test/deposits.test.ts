// 15.4 depósito PIX: intenção, cobrança, webhook assinado, titularidade, valor, prazo, devolução e crédito.
import { uuidv7 } from '@broker/ids';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  app,
  balancesOf,
  bearer,
  brl,
  deposit,
  openClient,
  outbox,
  randomCpf,
  startEnv,
  stopEnv,
  webhook,
  type App,
  type Client,
  type Env,
} from './helpers.js';

let env: Env;
let a: App;
beforeAll(async () => {
  env = await startEnv();
  a = await app(env);
}, 180_000);
afterAll(() => stopEnv(env));

const create = (c: Client, amount: string) =>
  a.http
    .post('/v1/me/deposits')
    .set(bearer(c.token))
    .set('Idempotency-Key', uuidv7())
    .send({ amount });

const get = async (c: Client, id: string) =>
  (await a.http.get(`/v1/me/deposits/${id}`).set(bearer(c.token)).expect(200)).body as {
    status: string;
    refundReason?: string;
  };

const txidOf = (id: string) => id.replaceAll('-', '');

const eventsOf = async (type: string, depositId: string) =>
  (await outbox(env.db, type)).filter((e) => e.payload['depositId'] === depositId);

describe('15.4 intenção de depósito (RN-DEP-001/002)', () => {
  it('cria a cobrança de 30 min no Banco Simulado e publica deposit.requested', async () => {
    const c = await openClient(a);
    const res = await create(c, '250.00').expect(201);
    expect(res.body).toMatchObject({ status: 'PENDING', amount: '250.00' });
    expect(Date.parse(res.body.expiresAt) - a.clock.now().epochMillis).toBe(30 * 60_000);
    expect(a.pix.charges.get(txidOf(res.body.id))).toMatchObject({ expiresInSeconds: 1800 });
    expect(await eventsOf('deposit.requested', res.body.id)).toHaveLength(1);
  });

  it('R$ 0,50 → 422 DEPOSIT_AMOUNT_OUT_OF_RANGE, sem cobrança', async () => {
    const c = await openClient(a);
    const before = a.pix.charges.size;
    const res = await create(c, '0.50').expect(422);
    expect(res.body.code).toBe('DEPOSIT_AMOUNT_OUT_OF_RANGE');
    expect((await create(c, '1000000.01').expect(422)).body.code).toBe(
      'DEPOSIT_AMOUNT_OUT_OF_RANGE',
    );
    expect(a.pix.charges.size).toBe(before);
  });

  it('conta bloqueada não abre cobrança; Banco Simulado fora → 503', async () => {
    const c = await openClient(a);
    await a.store.transaction((tx) =>
      a.accounts.onStatusChanged(tx, { accountId: c.accountId, to: 'BLOCKED' }),
    );
    expect((await create(c, '10.00').expect(422)).body.code).toBe('ACCOUNT_NOT_ACTIVE');
    const d = await openClient(a);
    a.pix.unavailable = true;
    try {
      expect((await create(d, '10.00').expect(503)).body.code).toBe('PIX_UNAVAILABLE');
    } finally {
      a.pix.unavailable = false;
    }
  });
});

describe('15.4 crédito pelo webhook (RN-DEP-003..008)', () => {
  it('pagamento do próprio cliente: D HOUSE_PIX_RESERVE / C CUST_CASH SETTLED e deposit.credited', async () => {
    const c = await openClient(a);
    const id = await deposit(a, c, '1500.00');
    expect(await get(c, id)).toMatchObject({ status: 'CREDITED' });
    expect(await balancesOf(a, c)).toMatchObject({ settled: '1500.00', withdrawable: '1500.00' });
    expect(await eventsOf('deposit.credited', id)).toHaveLength(1);
    const { rows } = await sql<{
      code: string;
      amount: { toFixed(n: number): string };
      status: string;
    }>`
      SELECT a.code, e.amount, e.status FROM journal j
      JOIN ledger_entry e ON e.journal_id = j.id JOIN ledger_account a ON a.id = e.account_id
      WHERE j.idempotency_key = ${`deposit:${id}`} ORDER BY a.code`.execute(env.db);
    expect(rows.map((r) => [r.code, r.amount.toFixed(2), r.status])).toEqual([
      ['CUST_CASH', '1500.00', 'SETTLED'],
      ['HOUSE_PIX_RESERVE', '-1500.00', 'SETTLED'],
    ]);
  });

  it('RN-DEP-005: o mesmo webhook entregue duas vezes credita uma vez só', async () => {
    const c = await openClient(a);
    const res = await create(c, '300.00').expect(201);
    const item = a.pix.pay(txidOf(res.body.id), c.taxId);
    await webhook(a, item).expect(204);
    await webhook(a, item).expect(204);
    await Promise.all([webhook(a, item), webhook(a, item)]);
    expect(await balancesOf(a, c)).toMatchObject({ settled: '300.00' });
    expect(await eventsOf('deposit.credited', res.body.id)).toHaveLength(1);
  });

  it('depósito de terceiro: devolvido integralmente, deposit.refunded e nenhum crédito', async () => {
    const c = await openClient(a);
    const res = await create(c, '800.00').expect(201);
    const item = a.pix.pay(txidOf(res.body.id), randomCpf());
    await webhook(a, item).expect(204);
    expect(await get(c, res.body.id)).toMatchObject({
      status: 'REFUNDED',
      refundReason: 'THIRD_PARTY_PAYER',
    });
    expect(a.pix.refunds.filter((r) => r.endToEndId === item.endToEndId)).toEqual([
      expect.objectContaining({ amount: brl('800.00') }),
    ]);
    expect((await eventsOf('deposit.refunded', res.body.id))[0]!.payload).toMatchObject({
      reason: 'THIRD_PARTY_PAYER',
      amount: '800.00',
    });
    expect(await balancesOf(a, c)).toMatchObject({ settled: '0.00' });
  });

  it('valor diferente da cobrança e conta bloqueada também são devolvidos', async () => {
    const c = await openClient(a);
    const res = await create(c, '100.00').expect(201);
    await webhook(a, a.pix.pay(txidOf(res.body.id), c.taxId, brl('99.00'))).expect(204);
    expect((await get(c, res.body.id)).refundReason).toBe('AMOUNT_MISMATCH');

    const b = await openClient(a);
    const other = await create(b, '100.00').expect(201);
    await a.store.transaction((tx) =>
      a.accounts.onStatusChanged(tx, { accountId: b.accountId, to: 'BLOCKED' }),
    );
    await webhook(a, a.pix.pay(txidOf(other.body.id), b.taxId)).expect(204);
    expect(await get(b, other.body.id)).toMatchObject({
      status: 'REFUNDED',
      refundReason: 'ACCOUNT_NOT_ACTIVE',
    });
  });

  it('pagamento após a expiração: a cobrança fica EXPIRED e o valor é devolvido', async () => {
    const c = await openClient(a);
    const res = await create(c, '120.00').expect(201);
    a.clock.advanceBy(31 * 60_000);
    // A rotina de expiração vence a cobrança; o webhook chega atrasado (RN-PIXS-003).
    expect(await a.deposits.expireDue()).toBeGreaterThanOrEqual(1);
    expect(await get(c, res.body.id)).toMatchObject({ status: 'EXPIRED' });
    await webhook(a, a.pix.pay(txidOf(res.body.id), c.taxId)).expect(204);
    expect(await get(c, res.body.id)).toMatchObject({ status: 'EXPIRED' });
    expect((await eventsOf('deposit.refunded', res.body.id))[0]!.payload['reason']).toBe(
      'INTENT_EXPIRED',
    );
    expect(await eventsOf('deposit.expired', res.body.id)).toHaveLength(1);
    expect(await balancesOf(a, c)).toMatchObject({ settled: '0.00' });
  });

  it('pago depois do vencimento, antes da rotina rodar: EXPIRED + deposit.expired e devolução', async () => {
    const c = await openClient(a);
    const res = await create(c, '60.00').expect(201);
    a.clock.advanceBy(30 * 60_000);
    await webhook(a, a.pix.pay(txidOf(res.body.id), c.taxId)).expect(204);
    expect(await get(c, res.body.id)).toMatchObject({
      status: 'EXPIRED',
      refundReason: 'INTENT_EXPIRED',
    });
    expect(await eventsOf('deposit.expired', res.body.id)).toHaveLength(1);
    expect(a.pix.refunds.some((r) => r.amount.equals(brl('60.00')))).toBe(true);
  });

  it('cobrança cancelada pelo cliente: o pagamento é devolvido', async () => {
    const c = await openClient(a);
    const res = await create(c, '45.00').expect(201);
    await a.http
      .post(`/v1/me/deposits/${res.body.id}/cancel`)
      .set(bearer(c.token))
      .set('Idempotency-Key', uuidv7())
      .expect(200);
    await webhook(a, a.pix.pay(txidOf(res.body.id), c.taxId)).expect(204);
    expect(await get(c, res.body.id)).toMatchObject({ status: 'CANCELED' });
    expect((await eventsOf('deposit.refunded', res.body.id))[0]!.payload['reason']).toBe(
      'INTENT_NOT_PENDING',
    );
  });

  it('devolução que falha no banco fica pendente e sai na próxima rodada (idempotente pelo id)', async () => {
    const c = await openClient(a);
    const res = await create(c, '70.00').expect(201);
    a.pix.failRefunds = 1;
    await webhook(a, a.pix.pay(txidOf(res.body.id), randomCpf())).expect(204);
    expect(await get(c, res.body.id)).toMatchObject({ status: 'PAID' });
    expect(await a.deposits.processRefunds()).toBe(1);
    expect(await get(c, res.body.id)).toMatchObject({ status: 'REFUNDED' });
    expect(await a.deposits.processRefunds()).toBe(0);
  });

  it('RN-DEP-008: assinatura inválida → 401 sem efeito; titularidade indisponível → 503 e o reenvio credita', async () => {
    const c = await openClient(a);
    const res = await create(c, '90.00').expect(201);
    const item = a.pix.pay(txidOf(res.body.id), c.taxId);
    expect((await webhook(a, item, 'outro-segredo-qualquer-0123456').expect(401)).body.code).toBe(
      'INVALID_WEBHOOK_SIGNATURE',
    );
    a.customers.unavailable = true;
    await webhook(a, item).expect(503);
    a.customers.unavailable = false;
    expect(await get(c, res.body.id)).toMatchObject({ status: 'PENDING' });
    await webhook(a, item).expect(204);
    expect(await get(c, res.body.id)).toMatchObject({ status: 'CREDITED' });
  });

  it('depósito de outra conta responde 404 (RN-AUTHZ-002)', async () => {
    const c = await openClient(a);
    const other = await openClient(a);
    const res = await create(c, '10.00').expect(201);
    await a.http.get(`/v1/me/deposits/${res.body.id}`).set(bearer(other.token)).expect(404);
  });
});
