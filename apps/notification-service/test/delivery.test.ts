// 18.2 entrega por canal com retentativa, silêncio, agrupamento e "ocultar valores"
// (RN-NOT-G-003/005..007).
import { testClock } from '@broker/testing';
import { uuidv7 } from '@broker/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOURCES } from '../src/application/sources.js';
import {
  app,
  bearer,
  client,
  deliveries,
  depositCredited,
  outbox,
  startEnv,
  stopEnv,
  type App,
  type Env,
} from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
}, 180_000);
afterAll(() => stopEnv(env));

const deposit = (a: App, accountId: string, amount = '1500.5') =>
  a.notify(SOURCES['deposit.credited']!(depositCredited(accountId, amount))!);

const statusOf = async (id: string) =>
  Object.fromEntries((await deliveries(env.db, id)).map((d) => [d.channel, d.status]));

async function registerDevice(a: App, token: string, userToken: string) {
  await a.http
    .post('/v1/me/push-devices')
    .set(bearer(userToken))
    .send({ platform: 'IOS', token })
    .expect(201);
}

describe('18.2 entrega por canal', () => {
  it('e-mail com o deep link, push no aparelho e notification.delivered por canal', async () => {
    const a = await app(env);
    const c = await client(a);
    const device = `apns-${uuidv7()}`;
    await registerDevice(a, device, c.token);
    const r = await deposit(a, c.accountId);
    await a.work();

    expect(a.email.sent).toEqual([
      {
        to: c.email,
        subject: 'Depósito creditado',
        text: expect.stringContaining('R$ 1.500,50') as unknown as string,
        messageId: `<${r.notificationId}.email@broker.localhost>`,
      },
    ]);
    expect(a.email.sent[0]!.text).toContain('Abra no app: https://app.broker.test/extrato');
    expect(a.sink.pushSent).toEqual([
      {
        deviceToken: device,
        title: 'Depósito creditado',
        body: expect.stringContaining('R$ 1.500,50') as unknown as string,
        data: expect.objectContaining({
          deepLink: '/extrato',
          notificationId: r.notificationId,
          code: 'DEPOSIT_CREDITED',
        }) as unknown as Record<string, string>,
      },
    ]);
    expect(await statusOf(r.notificationId!)).toEqual({
      EMAIL: 'DELIVERED',
      IN_APP: 'DELIVERED',
      PUSH: 'DELIVERED',
    });
    const delivered = (await outbox(env.db, 'notification.delivered')).filter(
      (e) => e.payload['notificationId'] === r.notificationId,
    );
    expect(delivered.map((e) => e.payload['channel']).sort()).toEqual(['EMAIL', 'PUSH']);
    // Nada a reenviar.
    await a.work();
    expect(a.email.sent).toHaveLength(1);
  });

  it('RN-NOT-G-007: transitório volta com backoff; depois do prazo, falha definitiva registrada', async () => {
    const a = await app(env);
    const c = await client(a);
    a.email.plan = ['TRANSIENT', 'TRANSIENT', 'OK'];
    const r = await deposit(a, c.accountId);
    await a.work();
    let email = (await deliveries(env.db, r.notificationId!)).find((d) => d.channel === 'EMAIL')!;
    expect(email).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'SMTP_UNAVAILABLE' });
    expect(email.next_attempt_at!.toISOString()).toBe('2026-10-27T14:01:00.000Z');
    // Antes do backoff, nada sai.
    a.clock.advanceBy(30_000);
    await a.work();
    expect(a.email.attempts).toBe(1);
    a.clock.advanceBy(30_000);
    await a.work();
    a.clock.advanceBy(2 * 60_000);
    await a.work();
    email = (await deliveries(env.db, r.notificationId!)).find((d) => d.channel === 'EMAIL')!;
    expect(email).toMatchObject({ status: 'DELIVERED', attempts: 3 });

    // Push sempre fora: falha definitiva quando a próxima tentativa passaria de 1 h.
    const other = await client(a);
    a.email.plan = ['TRANSIENT'];
    const late = await deposit(a, other.accountId);
    for (let i = 0; i < 40; i++) {
      await a.work();
      a.clock.advanceBy(60 * 60_000);
    }
    const rows = await deliveries(env.db, late.notificationId!);
    const failed = rows.find((d) => d.channel === 'EMAIL')!;
    expect(failed.status).toBe('FAILED');
    expect(failed.last_error).toMatch(/^DEADLINE_EXCEEDED/);
    // Prazo de 24 h com teto de 1 h: ~ 30 tentativas, nunca depois do prazo.
    expect(failed.attempts).toBeGreaterThan(20);
    expect(failed.attempts).toBeLessThan(35);
    const ev = (await outbox(env.db, 'notification.failed')).find(
      (e) => e.payload['notificationId'] === late.notificationId,
    )!;
    expect(ev.payload).toMatchObject({ channel: 'EMAIL', reason: 'DEADLINE_EXCEEDED' });
  });

  it('erro definitivo encerra na hora; sem e-mail cadastrado é falha; sem aparelho é SKIPPED', async () => {
    const a = await app(env);
    const c = await client(a);
    a.email.plan = ['DEFINITIVE'];
    const r = await deposit(a, c.accountId);
    await a.work();
    const rows = await deliveries(env.db, r.notificationId!);
    expect(rows.find((d) => d.channel === 'EMAIL')).toMatchObject({
      status: 'FAILED',
      attempts: 1,
    });
    expect(rows.find((d) => d.channel === 'PUSH')).toMatchObject({
      status: 'SKIPPED',
      last_error: 'NO_PUSH_DEVICE',
    });

    const noEmail = a.recipients.add({
      userId: uuidv7(),
      accountId: uuidv7(),
      email: null,
      phone: null,
    });
    a.email.plan = ['OK'];
    const n = await deposit(a, noEmail.accountId!);
    await a.work();
    expect(
      (await deliveries(env.db, n.notificationId!)).find((d) => d.channel === 'EMAIL'),
    ).toMatchObject({
      status: 'FAILED',
      last_error: expect.stringMatching(/^NO_EMAIL/) as unknown as string,
    });
  });

  it('aparelho não registrado no provedor fica UNREGISTERED e sai do próximo envio', async () => {
    const a = await app(env);
    const c = await client(a);
    const dead = `dead-${uuidv7()}`;
    const alive = `alive-${uuidv7()}`;
    await registerDevice(a, dead, c.token);
    await registerDevice(a, alive, c.token);
    a.sink.unregistered.add(dead);
    await deposit(a, c.accountId);
    await a.work();
    expect(a.sink.pushSent.map((p) => p.deviceToken)).toEqual([alive]);
    const devices = await a.store.transaction((tx) => tx.pushDevices(c.userId));
    expect(devices.map((d) => d.status)).toEqual(['ACTIVE']);
  });

  it('RN-NOT-G-003: com "ocultar valores", o push só diz que há uma movimentação', async () => {
    const a = await app(env);
    const c = await client(a);
    await registerDevice(a, `apns-${uuidv7()}`, c.token);
    await a.http
      .put('/v1/me/notification-preferences')
      .set(bearer(c.token))
      .send({ hideValues: true })
      .expect(200);
    await deposit(a, c.accountId);
    await a.work();
    expect(a.sink.pushSent[0]).toMatchObject({
      title: 'Broker',
      body: 'Há uma movimentação na sua conta.',
    });
    expect(JSON.stringify(a.sink.pushSent[0])).not.toContain('1.500');
    // O e-mail e a central seguem completos.
    expect(a.email.sent[0]!.text).toContain('R$ 1.500,50');
  });

  it('RN-NOT-G-006: no silêncio, média espera as 07:00; crítica e segurança saem na hora', async () => {
    // 23:30 em São Paulo.
    const a = await app(env, { clock: testClock('2026-10-28T02:30:00Z') });
    const c = await client(a);
    await a.http
      .put('/v1/me/notification-preferences')
      .set(bearer(c.token))
      .send({ quietHours: { start: '22:00', end: '07:00' } })
      .expect(200);

    const dep = await deposit(a, c.accountId);
    const zeragem = await a.notify({
      eventId: uuidv7(),
      code: 'FORCED_LIQUIDATION',
      recipient: { accountId: c.accountId },
      vars: {},
      deepLink: '/carteira',
    });
    const senha = await a.notify(
      SOURCES['identity.password_changed']!({
        eventId: uuidv7(),
        occurredAt: a.clock.now().toString(),
        payload: { userId: c.userId, at: a.clock.now().toString() },
      })!,
    );
    await a.work();

    // A crítica (zeragem) e a de segurança: entregues na hora.
    expect(await statusOf(zeragem.notificationId!)).toMatchObject({
      EMAIL: 'DELIVERED',
      SMS: 'DELIVERED',
    });
    expect(await statusOf(senha.notificationId!)).toEqual({ EMAIL: 'DELIVERED', SMS: 'DELIVERED' });
    expect(a.sink.smsSent.map((s) => s.body)).toEqual(
      expect.arrayContaining([
        'Broker: iniciamos a zeragem compulsória das suas posições. Veja o app.',
        'Broker: alteramos a sua senha em 27/10/2026 às 23:30. Não foi você? Fale com a central.',
      ]),
    );
    // O depósito (média): na central já, e-mail às 07:00 (10:00Z).
    const depEmail = (await deliveries(env.db, dep.notificationId!)).find(
      (d) => d.channel === 'EMAIL',
    )!;
    expect(depEmail.status).toBe('PENDING');
    expect(depEmail.next_attempt_at!.toISOString()).toBe('2026-10-28T10:00:00.000Z');
    expect(
      (await a.http.get('/v1/me/notifications').set(bearer(c.token)).expect(200)).body.items.map(
        (n: { code: string }) => n.code,
      ),
    ).toContain('DEPOSIT_CREDITED');
    a.clock.advanceTo(a.clock.now().plusMillis(7.5 * 3_600_000));
    await a.work();
    expect(await statusOf(dep.notificationId!)).toMatchObject({ EMAIL: 'DELIVERED' });
  });

  it('RN-NOT-G-005: três parciais da mesma ordem em 3 s viram uma notificação com o total', async () => {
    const a = await app(env);
    const c = await client(a);
    const orderId = uuidv7();
    const partial = (filled: string) =>
      a.notify({
        eventId: uuidv7(),
        code: 'ORDER_PARTIALLY_FILLED',
        recipient: { accountId: c.accountId },
        vars: { orderId, filledQuantity: filled, quantity: '1000', symbol: 'PETR4' },
        data: { orderId },
        deepLink: `/ordens/${orderId}`,
      });
    const first = await partial('100');
    a.clock.advanceBy(1500);
    expect(await partial('200')).toEqual({
      outcome: 'MERGED',
      notificationId: first.notificationId,
    });
    a.clock.advanceBy(1500);
    expect((await partial('300')).outcome).toBe('MERGED');

    // Dentro da janela: nada na central nem no barramento.
    await a.work();
    const list = () => a.http.get('/v1/me/notifications').set(bearer(c.token)).expect(200);
    expect((await list()).body.items).toEqual([]);
    const created = async () =>
      (await outbox(env.db, 'notification.created')).filter(
        (e) => e.payload['notificationId'] === first.notificationId,
      );
    expect(await created()).toHaveLength(0);

    a.clock.advanceBy(2500);
    await a.work();
    const items = (await list()).body.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      code: 'ORDER_PARTIALLY_FILLED',
      body: 'Ordem executada parcialmente: 300 de 1.000 PETR4.',
      data: { orderId, deepLink: `/ordens/${orderId}` },
    });
    expect(await created()).toHaveLength(1);

    // Depois da janela, uma parcial nova abre outra notificação.
    expect((await partial('400')).outcome).toBe('CREATED');
  });
});
