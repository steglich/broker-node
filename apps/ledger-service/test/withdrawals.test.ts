// 15.5 saga de saque: hold (adaptador local da Fase 1), limites, revisão, retentativas e estados.
import { Instant } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import { testClock } from '@broker/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  app,
  backofficeToken,
  balancesOf,
  bearer,
  customerToken,
  deposit,
  openClient,
  outbox,
  signatureToken,
  startEnv,
  stopEnv,
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

/** Conta de saque cadastrada no customer-service falso (já fora da carência, por padrão). */
function destination(
  x: App,
  c: Client,
  opts: { availableFrom?: Instant; status?: 'ACTIVE' | 'REMOVED' } = {},
) {
  const id = uuidv7();
  x.customers.destinations.set(id, {
    id,
    accountId: c.accountId,
    status: opts.status ?? 'ACTIVE',
    pixKey: `${c.taxId}`,
    availableFrom: opts.availableFrom ?? x.clock.now().plusMillis(-48 * 3_600_000),
    holderTaxId: c.taxId,
  });
  return id;
}

/** Pede o saque com assinatura; `status` confere o código HTTP esperado. */
async function request(
  x: App,
  c: Client,
  amount: string,
  bankAccountId: string,
  opts: { status?: number; signature?: boolean } = {},
) {
  const req = x.http
    .post('/v1/me/withdrawals')
    .set(bearer(c.token))
    .set('Idempotency-Key', uuidv7());
  if (opts.signature ?? true)
    req.set('X-Trading-Signature', await signatureToken(x.clock, c.userId, 'WITHDRAWALS'));
  const res = await req.send({ amount, bankAccountId });
  if (opts.status !== undefined) expect(res.status, JSON.stringify(res.body)).toBe(opts.status);
  return res;
}

const getW = async (x: App, c: Client, id: string) =>
  (await x.http.get(`/v1/me/withdrawals/${id}`).set(bearer(c.token)).expect(200)).body as {
    status: string;
    failureReason?: string;
    endToEndId?: string;
  };

const holdOf = async (id: string) =>
  (
    await sql<{ status: string }>`SELECT status FROM withdrawal_hold WHERE id = ${id}`.execute(
      env.db,
    )
  ).rows[0]?.status;

const eventsOf = async (type: string, withdrawalId: string) =>
  (await outbox(env.db, type)).filter((e) => e.payload['withdrawalId'] === withdrawalId);

async function funded(x: App, amount: string) {
  const c = await openClient(x);
  await deposit(x, c, amount);
  return c;
}

describe('15.5 saque concluído (RN-LED-032)', () => {
  it('hold criado, PIX confirmado: D CUST_CASH / C HOUSE_PIX_RESERVE, hold consumido e withdrawal.completed', async () => {
    const c = await funded(a, '2000.00');
    const res = await request(a, c, '500.00', destination(a, c), { status: 202 });
    expect(res.body.status).toBe('PROCESSING');
    // Enquanto o envio não sai, o hold já desconta do sacável.
    expect(await balancesOf(a, c)).toMatchObject({
      settled: '2000.00',
      holds: '500.00',
      withdrawable: '1500.00',
    });

    expect(await a.withdrawals.processDue()).toBe(1);
    const w = await getW(a, c, res.body.id);
    expect(w.status).toBe('COMPLETED');
    expect(a.pix.sends.get(res.body.id.replaceAll('-', ''))).toMatchObject({ pixKey: c.taxId });
    expect(await holdOf(res.body.id)).toBe('CONSUMED');
    expect(await balancesOf(a, c)).toMatchObject({
      settled: '1500.00',
      holds: '0.00',
      withdrawable: '1500.00',
    });
    expect(await eventsOf('withdrawal.requested', res.body.id)).toHaveLength(1);
    expect(await eventsOf('withdrawal.completed', res.body.id)).toHaveLength(1);
  });

  it('saldo insuficiente: o Risco recusa o hold, 422 INSUFFICIENT_WITHDRAWABLE_BALANCE e nada vai ao PIX', async () => {
    const c = await funded(a, '100.00');
    const sends = a.pix.sendAttempts;
    const res = await request(a, c, '100.01', destination(a, c), { status: 422 });
    expect(res.body.code).toBe('INSUFFICIENT_WITHDRAWABLE_BALANCE');
    await a.withdrawals.processDue();
    expect(a.pix.sendAttempts).toBe(sends);
    const [w] = (await a.http.get('/v1/me/withdrawals').set(bearer(c.token))).body.items;
    expect(w).toMatchObject({
      status: 'REJECTED',
      failureReason: 'INSUFFICIENT_WITHDRAWABLE_BALANCE',
    });
    expect(await eventsOf('withdrawal.rejected', w.id)).toHaveLength(1);
  });

  it('dois saques simultâneos não gastam o mesmo saldo (serialização pela conta)', async () => {
    const c = await funded(a, '1000.00');
    const dest = destination(a, c);
    const results = await Promise.all([
      request(a, c, '700.00', dest),
      request(a, c, '700.00', dest),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([202, 422]);
  });
});

describe('15.5 regras do saque (RN-SAQ-001..004)', () => {
  it('sem assinatura eletrônica com escopo WITHDRAWALS → TRADING_SIGNATURE_REQUIRED', async () => {
    const c = await funded(a, '50.00');
    const res = await request(a, c, '10.00', destination(a, c), { signature: false });
    expect(res.body.code).toBe('TRADING_SIGNATURE_REQUIRED');
  });

  it('abaixo de R$ 1,00, destino em carência, removido ou de outra conta', async () => {
    const c = await funded(a, '50.00');
    expect((await request(a, c, '0.99', destination(a, c), { status: 422 })).body.code).toBe(
      'WITHDRAWAL_AMOUNT_TOO_LOW',
    );
    // Conta cadastrada há 2 horas: ainda na carência de 24 h (RN-ACC-021).
    const fresh = destination(a, c, { availableFrom: a.clock.now().plusMillis(22 * 3_600_000) });
    expect((await request(a, c, '10.00', fresh, { status: 422 })).body.code).toBe(
      'BANK_ACCOUNT_NOT_ALLOWED',
    );
    const removed = destination(a, c, { status: 'REMOVED' });
    expect((await request(a, c, '10.00', removed, { status: 422 })).body.code).toBe(
      'BANK_ACCOUNT_NOT_ALLOWED',
    );
    const other = await openClient(a);
    expect((await request(a, c, '10.00', destination(a, other), { status: 422 })).body.code).toBe(
      'BANK_ACCOUNT_NOT_ALLOWED',
    );
  });

  it('conta que não pode sacar (ex.: restrita por saldo devedor) → código da elegibilidade', async () => {
    const c = await funded(a, '50.00');
    a.customers.blockedWithdraw.add(c.accountId);
    expect((await request(a, c, '10.00', destination(a, c), { status: 422 })).body.code).toBe(
      'ACCOUNT_NOT_ACTIVE',
    );
  });

  it('limite noturno: R$ 1.500 às 22h → 422 WITHDRAWAL_LIMIT_EXCEEDED; R$ 1.000 passa', async () => {
    const night = await app(env, { clock: testClock({ date: '2026-01-05', time: '22:00' }) });
    const c = await funded(night, '5000.00');
    const dest = destination(night, c);
    const res = await request(night, c, '1500.00', dest, { status: 422 });
    expect(res.body).toMatchObject({
      code: 'WITHDRAWAL_LIMIT_EXCEEDED',
      context: { limit: 'NIGHTLY' },
    });
    await request(night, c, '1000.00', dest, { status: 202 });
  });

  it('limite diário de R$ 100 mil soma os saques do dia (um em revisão também conta)', async () => {
    const c = await funded(a, '200000.00');
    const dest = destination(a, c);
    expect((await request(a, c, '60000.00', dest, { status: 202 })).body.status).toBe(
      'PENDING_REVIEW',
    );
    const res = await request(a, c, '45000.00', dest, { status: 422 });
    expect(res.body).toMatchObject({
      code: 'WITHDRAWAL_LIMIT_EXCEEDED',
      context: { limit: 'DAILY' },
    });
    await request(a, c, '40000.00', dest, { status: 202 });
  });
});

describe('15.5 revisão, cancelamento e retentativas (RN-SAQ-005..008)', () => {
  it('acima de R$ 50 mil: PENDING_REVIEW com hold; aprovado segue; reprovado libera o hold', async () => {
    const c = await funded(a, '120000.00');
    const dest = destination(a, c);
    const first = await request(a, c, '50000.01', dest, { status: 202 });
    expect(first.body.status).toBe('PENDING_REVIEW');
    expect(await holdOf(first.body.id)).toBe('ACTIVE');
    await a.withdrawals.processDue();
    expect((await getW(a, c, first.body.id)).status).toBe('PENDING_REVIEW');

    const finance = await backofficeToken(a.clock, ['BO_FINANCE']);
    const queue = (await a.http.get('/v1/bo/withdrawals').set(bearer(finance)).expect(200)).body
      .items;
    expect(queue.map((w: { id: string }) => w.id)).toContain(first.body.id);
    await a.http
      .post(`/v1/bo/withdrawals/${first.body.id}/approve`)
      .set(bearer(await backofficeToken(a.clock, ['BO_SUPPORT'])))
      .expect(403);
    await a.http
      .post(`/v1/bo/withdrawals/${first.body.id}/approve`)
      .set(bearer(finance))
      .expect(200);
    await a.withdrawals.processDue();
    expect((await getW(a, c, first.body.id)).status).toBe('COMPLETED');

    // Outro cliente: o primeiro já usou R$ 50 mil do limite diário.
    const d = await funded(a, '70000.00');
    const second = await request(a, d, '60000.00', destination(a, d), { status: 202 });
    await a.http
      .post(`/v1/bo/withdrawals/${second.body.id}/reject`)
      .set(bearer(finance))
      .send({ reason: 'destino suspeito' })
      .expect(200);
    expect(await getW(a, d, second.body.id)).toMatchObject({
      status: 'REJECTED',
      failureReason: 'destino suspeito',
    });
    expect(await holdOf(second.body.id)).toBe('RELEASED');
    expect(await eventsOf('withdrawal.rejected', second.body.id)).toHaveLength(1);
  });

  it('cancelamento só antes de PROCESSING; libera o hold', async () => {
    const c = await funded(a, '90000.00');
    const dest = destination(a, c);
    const review = await request(a, c, '55000.00', dest, { status: 202 });
    await a.http
      .post(`/v1/me/withdrawals/${review.body.id}/cancel`)
      .set(bearer(c.token))
      .set('Idempotency-Key', uuidv7())
      .expect(200);
    expect(await holdOf(review.body.id)).toBe('RELEASED');
    const processing = await request(a, c, '10.00', dest, { status: 202 });
    const res = await a.http
      .post(`/v1/me/withdrawals/${processing.body.id}/cancel`)
      .set(bearer(c.token))
      .set('Idempotency-Key', uuidv7())
      .expect(422);
    expect(res.body.code).toBe('WITHDRAWAL_NOT_CANCELABLE');
  });

  it('falha definitiva: o simulador falha nas 5 tentativas → FAILED, hold liberado e withdrawal.failed', async () => {
    const x = await app(env);
    const c = await funded(x, '1000.00');
    const res = await request(x, c, '300.00', destination(x, c), { status: 202 });
    x.pix.sendPlan = ['TRANSIENT'];
    const before = x.pix.sendAttempts;
    // Cada rodada no instante da próxima tentativa (backoff 1, 2, 4, 8 min).
    for (let i = 0; i < 8; i++) {
      await x.withdrawals.processDue();
      x.clock.advanceBy(60_000 * 2 ** i);
    }
    c.token = await customerToken(x.clock, c.userId, c.accountId);
    expect(x.pix.sendAttempts - before).toBe(5);
    expect(await getW(x, c, res.body.id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'PIX_UNAVAILABLE',
    });
    expect(await holdOf(res.body.id)).toBe('RELEASED');
    expect(await eventsOf('withdrawal.failed', res.body.id)).toHaveLength(1);
    expect(await balancesOf(x, c)).toMatchObject({ settled: '1000.00', withdrawable: '1000.00' });
  });

  it('recusa do banco (chave inexistente) é definitiva na primeira tentativa', async () => {
    const x = await app(env);
    const c = await funded(x, '100.00');
    x.pix.sendPlan = [{ definitive: 'CHAVE_INEXISTENTE' }];
    const res = await request(x, c, '40.00', destination(x, c), { status: 202 });
    await x.withdrawals.processDue();
    expect(await getW(x, c, res.body.id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'CHAVE_INEXISTENTE',
    });
    expect(x.pix.sendAttempts).toBe(1);
    expect(await holdOf(res.body.id)).toBe('RELEASED');
  });

  it('a saga é retomável: falha transitória, reinício do serviço e o próximo processo conclui', async () => {
    const first = await app(env);
    const c = await funded(first, '500.00');
    const dest = destination(first, c);
    first.pix.sendPlan = ['TRANSIENT'];
    const res = await request(first, c, '200.00', dest, { status: 202 });
    await first.withdrawals.processDue();
    expect((await getW(first, c, res.body.id)).status).toBe('PROCESSING');

    // Outra instância (mesmo banco), depois do backoff: o estado está na linha do saque.
    const second = await app(env, {
      clock: testClock(
        first.clock
          .now()
          .plusMillis(2 * 60_000)
          .toString(),
      ),
    });
    second.customers.destinations.set(dest, first.customers.destinations.get(dest)!);
    await second.withdrawals.processDue();
    expect((await getW(second, c, res.body.id)).status).toBe('COMPLETED');
    expect(await holdOf(res.body.id)).toBe('CONSUMED');
  });
});
