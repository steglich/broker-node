// 18.1 catálogo, templates, preferências, idempotência e central in-app (RN-NOT-G-001..004/008).
import { uuidv7 } from '@broker/ids';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SOURCES } from '../src/application/sources.js';
import {
  app,
  bearer,
  client,
  customerToken,
  deliveries,
  depositCredited,
  outbox,
  startEnv,
  stopEnv,
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
  a = await app(env);
});

const deposit = (accountId: string, amount: string, eventId?: string) =>
  a.notify(SOURCES['deposit.credited']!(depositCredited(accountId, amount, eventId))!);

describe('18.1 catálogo, templates e idempotência', () => {
  it('DEPOSIT_CREDITED: R$ 1.500,50, hora de São Paulo, deep link e canais do catálogo', async () => {
    const c = await client(a);
    const r = await deposit(c.accountId, '1500.5');
    expect(r.outcome).toBe('CREATED');
    const n = (await a.store.transaction((tx) => tx.notification(r.notificationId!)))!;
    expect(n).toMatchObject({
      userId: c.userId,
      accountId: c.accountId,
      code: 'DEPOSIT_CREDITED',
      title: 'Depósito creditado',
      priority: 'MEDIUM',
      channels: ['IN_APP', 'PUSH', 'EMAIL'],
      templateVersion: 1,
    });
    // 14:00Z = 11:00 em São Paulo.
    expect(n.body).toBe(
      'Recebemos o seu depósito de R$ 1.500,50 em 27/10/2026 às 11:00. O valor já está disponível na sua conta.',
    );
    expect(n.data['deepLink']).toBe('/extrato');
    expect(n.data['depositId']).toBeDefined();

    const created = (await outbox(env.db, 'notification.created')).find(
      (e) => e.payload['notificationId'] === n.id,
    )!;
    expect(created.partition_key).toBe(c.userId);
    expect(created.payload).toMatchObject({
      userId: c.userId,
      code: 'DEPOSIT_CREDITED',
      title: 'Depósito creditado',
      priority: 'MEDIUM',
      deepLink: '/extrato',
    });
  });

  it('RN-NOT-G-004: o mesmo evento duas vezes gera uma notificação e uma entrega por canal', async () => {
    const c = await client(a);
    const eventId = uuidv7();
    const first = await deposit(c.accountId, '10.00', eventId);
    expect((await deposit(c.accountId, '10.00', eventId)).outcome).toBe('DUPLICATE');
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM notification WHERE user_id = ${c.userId}`.execute(env.db);
    expect(Number(rows[0]!.n)).toBe(1);
    expect((await deliveries(env.db, first.notificationId!)).map((d) => d.channel)).toEqual([
      'EMAIL',
      'IN_APP',
      'PUSH',
    ]);
    // Mesmo evento, outro código, é outra notificação (o par é a chave).
    const other = SOURCES['deposit.credited']!(depositCredited(c.accountId, '10.00', eventId))!;
    expect(
      (await a.notify({ ...other, code: 'DEPOSIT_REFUNDED', vars: { ...other.vars, reason: 'x' } }))
        .outcome,
    ).toBe('CREATED');
  });

  it('evento sem destinatário conhecido não gera nada; diretório fora do ar propaga (o consumidor retenta)', async () => {
    expect((await deposit(uuidv7(), '10.00')).outcome).toBe('NO_RECIPIENT');
    const c = await client(a);
    a.recipients.unavailable = true;
    await expect(deposit(c.accountId, '10.00')).rejects.toThrow(/fora do ar/);
    a.recipients.unavailable = false;
    // A falha desfez a reserva do par: o reprocessamento notifica.
    expect((await deposit(c.accountId, '10.00')).outcome).toBe('CREATED');
  });

  it('template versionado: a v2 vale a partir do valid_from', async () => {
    const c = await client(a);
    await sql`
      INSERT INTO notification_template (code, channel, version, locale, title_tpl, body_tpl, valid_from)
      VALUES ('DEPOSIT_CREDITED', 'ANY', 2, 'pt-BR', 'Depósito recebido', 'Entrou {{amount|money}}.',
              '2026-10-28T00:00:00Z')`.execute(env.owner);
    const before = await deposit(c.accountId, '20.00');
    a.clock.advanceBy(24 * 3_600_000);
    const after = await deposit(c.accountId, '20.00');
    const get = (id: string) => a.store.transaction((tx) => tx.notification(id));
    expect((await get(before.notificationId!))!.body).toMatch(/^Recebemos/);
    expect(await get(after.notificationId!)).toMatchObject({
      title: 'Depósito recebido',
      body: 'Entrou R$ 20,00.',
      templateVersion: 2,
    });
    await sql`DELETE FROM notification_template WHERE version = 2`.execute(env.owner);
  });

  it('todos os eventos da Fase 1 têm template e viram texto sem variável pendente', async () => {
    const c = a.recipients.add({
      userId: uuidv7(),
      accountId: uuidv7(),
      email: 'todos@exemplo.com',
      phone: '+5511900000000',
    });
    const customerId = uuidv7();
    const applicationId = uuidv7();
    a.recipients.add({ ...c, customerId, applicationId });
    const payloads: Record<string, object> = {
      'deposit.credited': { depositId: uuidv7(), accountId: c.accountId, amount: '1.00' },
      'deposit.refunded': {
        depositId: uuidv7(),
        accountId: c.accountId,
        amount: '1.00',
        reason: 'THIRD_PARTY_PAYER',
      },
      'withdrawal.completed': { withdrawalId: uuidv7(), accountId: c.accountId, amount: '1.00' },
      'withdrawal.failed': { withdrawalId: uuidv7(), accountId: c.accountId, amount: '1.00' },
      'withdrawal.rejected': { withdrawalId: uuidv7(), accountId: c.accountId, amount: '1.00' },
      'ledger.negative_balance_detected': { accountId: c.accountId, settledBalance: '-12.30' },
      'account.status_changed': { accountId: c.accountId, from: 'ACTIVE', to: 'BLOCKED' },
      'suitability.expiring': { customerId, validUntil: '2026-11-26' },
      'suitability.expired': { customerId, validUntil: '2026-11-26' },
      'onboarding.submitted': { applicationId },
      'onboarding.approved': { applicationId },
      'onboarding.rejected': { applicationId },
      'identity.new_device_detected': { userId: c.userId, deviceId: uuidv7(), channel: 'WEB' },
      'identity.password_changed': { userId: c.userId, at: '2026-10-27T14:00:00Z' },
      'identity.trading_signature_changed': { userId: c.userId, at: '2026-10-27T14:00:00Z' },
    };
    expect(Object.keys(payloads).sort()).toEqual(Object.keys(SOURCES).sort());
    for (const [type, payload] of Object.entries(payloads)) {
      const s = SOURCES[type]!({ eventId: uuidv7(), occurredAt: '2026-10-27T14:00:00Z', payload })!;
      const r = await a.notify(s);
      expect(r.outcome, type).toBe('CREATED');
      for (const d of await deliveries(env.db, r.notificationId!)) {
        expect(`${d.title} ${d.body}`, `${type}/${d.channel}`).not.toMatch(/\{\{|undefined/);
      }
    }
    // Status igual nos dois lados não notifica.
    expect(
      SOURCES['account.status_changed']!({
        eventId: uuidv7(),
        occurredAt: '2026-10-27T14:00:00Z',
        payload: { accountId: c.accountId, from: 'ACTIVE', to: 'ACTIVE' },
      }),
    ).toBeNull();
  });
});

describe('18.1 central in-app (Contratos §8)', () => {
  it('lista mais recentes primeiro com cursor, conta as não lidas e marca por IDs ou todas', async () => {
    const c = await client(a);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await deposit(c.accountId, `${i + 1}.00`)).notificationId!);
      a.clock.advanceBy(1000);
    }
    const h = bearer(c.token);
    const page1 = (await a.http.get('/v1/me/notifications?limit=2').set(h).expect(200)).body;
    expect(page1.items.map((n: { id: string }) => n.id)).toEqual([ids[2], ids[1]]);
    expect(page1.unreadCount).toBe(3);
    expect(page1.items[0]).toMatchObject({
      code: 'DEPOSIT_CREDITED',
      readAt: null,
      data: { deepLink: '/extrato' },
    });
    const page2 = (
      await a.http.get(`/v1/me/notifications?limit=2&cursor=${page1.nextCursor}`).set(h).expect(200)
    ).body;
    expect(page2.items.map((n: { id: string }) => n.id)).toEqual([ids[0]]);
    expect(page2.nextCursor).toBeUndefined();

    // Outro usuário não marca as de ninguém.
    const intruder = await customerToken(a.clock, uuidv7());
    expect(
      (
        await a.http
          .post('/v1/me/notifications/read')
          .set(bearer(intruder))
          .send({ ids })
          .expect(200)
      ).body,
    ).toEqual({ updated: 0 });

    expect(
      (
        await a.http
          .post('/v1/me/notifications/read')
          .set(h)
          .send({ ids: [ids[0]] })
          .expect(200)
      ).body,
    ).toEqual({ updated: 1 });
    expect(
      (await a.http.get('/v1/me/notifications?unread=true').set(h).expect(200)).body.items,
    ).toHaveLength(2);
    expect(
      (await a.http.post('/v1/me/notifications/read').set(h).send({ all: true }).expect(200)).body,
    ).toEqual({ updated: 2 });
    expect((await a.http.get('/v1/me/notifications').set(h).expect(200)).body.unreadCount).toBe(0);
    const read = (await outbox(env.db, 'notification.read')).filter(
      (e) => e.payload['userId'] === c.userId,
    );
    expect(read.map((e) => (e.payload['notificationIds'] as string[]).length)).toEqual([1, 2]);
    await a.http.post('/v1/me/notifications/read').set(h).send({}).expect(400);
  });

  it('só canais com IN_APP aparecem na central (SECURITY_NEW_DEVICE é e-mail e push)', async () => {
    const c = await client(a);
    await a.notify(
      SOURCES['identity.new_device_detected']!({
        eventId: uuidv7(),
        occurredAt: a.clock.now().toString(),
        payload: { userId: c.userId, deviceId: uuidv7(), channel: 'MOBILE' },
      })!,
    );
    expect(
      (await a.http.get('/v1/me/notifications').set(bearer(c.token)).expect(200)).body.items,
    ).toEqual([]);
  });

  it('RN-NOT-G-008: retenção de 90 dias', async () => {
    const c = await client(a);
    const old = await deposit(c.accountId, '5.00');
    a.clock.advanceBy(89 * 86_400_000);
    const recent = await deposit(c.accountId, '6.00');
    a.clock.advanceBy(2 * 86_400_000);
    expect(await a.dispatcher.purge()).toBeGreaterThanOrEqual(1);
    const get = (id: string) => a.store.transaction((tx) => tx.notification(id));
    expect(await get(old.notificationId!)).toBeNull();
    expect(await get(recent.notificationId!)).not.toBeNull();
    expect(await deliveries(env.db, old.notificationId!)).toEqual([]);
  });
});

describe('18.1 preferências e tokens de push', () => {
  it('desativar ORDER_PARTIALLY_FILLED: as próximas parciais não geram notificação', async () => {
    const c = await client(a);
    const h = bearer(c.token);
    const prefs = (await a.http.get('/v1/me/notification-preferences').set(h).expect(200)).body;
    expect(prefs.quietHours).toBeNull();
    expect(prefs.hideValues).toBe(false);
    const byCode = (code: string) =>
      prefs.items.find((i: { code: string }) => i.code === code) as {
        canDisable: boolean;
        channels: { channel: string; enabled: boolean }[];
      };
    expect(byCode('DEPOSIT_CREDITED').canDisable).toBe(false);
    expect(byCode('DAILY_SUMMARY').channels.every((x) => !x.enabled)).toBe(true);

    await a.http
      .put('/v1/me/notification-preferences')
      .set(h)
      .send({ preferences: [{ code: 'ORDER_PARTIALLY_FILLED', enabled: false }] })
      .expect(200);
    const r = await a.notify({
      eventId: uuidv7(),
      code: 'ORDER_PARTIALLY_FILLED',
      recipient: { accountId: c.accountId },
      vars: { orderId: uuidv7(), filledQuantity: '100', quantity: '1000', symbol: 'PETR4' },
      deepLink: '/ordens',
    });
    expect(r.outcome).toBe('DISABLED');

    // Desligar só um canal de uma opcional.
    const after = (
      await a.http
        .put('/v1/me/notification-preferences')
        .set(h)
        .send({ preferences: [{ code: 'ORDER_FILLED', channel: 'PUSH', enabled: false }] })
        .expect(200)
    ).body;
    expect(after.items.find((i: { code: string }) => i.code === 'ORDER_FILLED').channels).toEqual([
      { channel: 'IN_APP', enabled: true },
      { channel: 'PUSH', enabled: false },
      { channel: 'DESKTOP', enabled: true },
    ]);
  });

  it('obrigatória, código desconhecido e canal fora do padrão: 422', async () => {
    const c = await client(a);
    const put = (body: object) =>
      a.http.put('/v1/me/notification-preferences').set(bearer(c.token)).send(body);
    expect(
      (await put({ preferences: [{ code: 'MARGIN_CALL', enabled: false }] }).expect(422)).body.code,
    ).toBe('NOTIFICATION_NOT_OPTIONAL');
    expect(
      (await put({ preferences: [{ code: 'NOPE', enabled: false }] }).expect(422)).body.code,
    ).toBe('UNKNOWN_NOTIFICATION_CODE');
    expect(
      (
        await put({
          preferences: [{ code: 'ORDER_FILLED', channel: 'SMS', enabled: true }],
        }).expect(422)
      ).body.code,
    ).toBe('CHANNEL_NOT_AVAILABLE');
    await put({ quietHours: { start: '25:00', end: '07:00' } }).expect(400);
  });

  it('token de push cifrado no banco; o mesmo token de novo renova (200)', async () => {
    const c = await client(a);
    const h = bearer(c.token);
    const token = `fcm-${uuidv7()}`;
    const first = await a.http
      .post('/v1/me/push-devices')
      .set(h)
      .send({ platform: 'ANDROID', token })
      .expect(201);
    const again = await a.http
      .post('/v1/me/push-devices')
      .set(h)
      .send({ platform: 'ANDROID', token })
      .expect(200);
    expect(again.body.id).toBe(first.body.id);
    const { rows } = await sql<{ token_enc: string }>`
      SELECT token_enc FROM push_device_token WHERE id = ${first.body.id as string}`.execute(
      env.db,
    );
    expect(rows[0]!.token_enc).not.toContain(token);
  });
});
