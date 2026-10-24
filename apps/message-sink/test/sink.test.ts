// Testes de componente da caixa de SMS e push (RN-MSG-001..003).
import { uuidv7 } from '@broker/ids';
import { createDatabase, migrateToLatest } from '@broker/persistence';
import { createLogger } from '@broker/service-kit';
import { NO_FAULTS } from '@broker/simulator-kit';
import { testClock } from '@broker/testing';
import { databaseConfig, startPostgres, type StartedPostgres } from '@broker/testing/containers';
import { sql, type Kysely } from 'kysely';
import { Writable } from 'node:stream';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMessageSink } from '../src/app.js';
import { migrations } from '../src/migrations.js';

let pg: StartedPostgres;
let db: Kysely<unknown>;
beforeAll(async () => {
  pg = await startPostgres(['sink']);
  const migrator = createDatabase(databaseConfig(pg, 'sink', 'migrator'));
  await migrateToLatest(migrator, migrations);
  await migrator.destroy();
  db = createDatabase(databaseConfig(pg, 'sink', 'app'));
});
afterAll(async () => {
  await db?.destroy();
  await pg?.container.stop();
});

async function sink() {
  await sql`DELETE FROM message`.execute(db);
  const clock = testClock('2026-03-02T13:00:00Z');
  const silent = new Writable({ write: (_c, _e, cb) => cb() });
  const logger = createLogger({
    service: 'message-sink',
    environment: 'test',
    version: '0',
    level: 'fatal',
    clock,
    destination: silent,
  });
  return createMessageSink({
    config: {
      SERVICE_NAME: 'message-sink',
      SERVICE_VERSION: '0',
      GIT_COMMIT: 'x',
      ENVIRONMENT: 'test',
      PORT: 0,
      LOG_LEVEL: 'fatal',
      SHUTDOWN_TIMEOUT_MS: 0,
    },
    db,
    clock,
    logger,
    behavior: NO_FAULTS,
    newId: uuidv7,
    mailboxUrl: 'https://mail.broker.localhost',
  });
}

describe('caixa de SMS e push (RN-MSG-001..003)', () => {
  it('RN-MSG-001/003: SMS fica registrado com o status de entrega e é consultável', async () => {
    const { service } = await sink();
    const res = await request(service.app)
      .post('/v1/sms')
      .send({ to: '+5511987654321', body: 'Seu código é 123456' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'DELIVERED', error: null });
    const msg = (await request(service.app).get(`/v1/messages/${res.body.message_id}`)).body;
    expect(msg).toMatchObject({
      channel: 'SMS',
      to: '+5511987654321',
      body: 'Seu código é 123456',
      status: 'DELIVERED',
      created_at: '2026-03-02T13:00:00.000Z',
    });
  });

  it('RN-MSG-002: push fica registrado com título e dados', async () => {
    const { service } = await sink();
    const res = await request(service.app)
      .post('/v1/push')
      .send({
        device_token: 'device-token-abc',
        title: 'Ordem executada',
        body: 'PETR4 100 @ 38,50',
        data: { orderId: 'o-1' },
      });
    expect(res.status).toBe(202);
    const list = (await request(service.app).get('/v1/messages').query({ channel: 'PUSH' })).body
      .messages;
    expect(list).toEqual([
      expect.objectContaining({
        to: 'device-token-abc',
        title: 'Ordem executada',
        data: { orderId: 'o-1' },
      }),
    ]);
  });

  it('RN-MSG-003: falha de entrega forçada fica registrada com o motivo', async () => {
    const { service } = await sink();
    await request(service.app).post('/admin/scenarios').send({ scenario: 'PUSH_UNREGISTERED' });
    const res = await request(service.app)
      .post('/v1/push')
      .send({ device_token: 'device-token-old', title: 't', body: 'b' });
    expect(res.body).toMatchObject({ status: 'FAILED', error: 'UNREGISTERED_DEVICE' });
    expect(
      (
        await request(service.app)
          .post('/v1/push')
          .send({ device_token: 'device-token-old', title: 't', body: 'b' })
      ).body.status,
    ).toBe('DELIVERED');
  });

  it('valida o formato do telefone (E.164)', async () => {
    const { service } = await sink();
    expect(
      (await request(service.app).post('/v1/sms').send({ to: '11987654321', body: 'x' })).status,
    ).toBe(400);
  });

  it('RN-SIM-005: a UI lista SMS e push e aponta para a caixa de e-mail', async () => {
    const { service } = await sink();
    await request(service.app).post('/v1/sms').send({ to: '+5511900000000', body: '<b>oi</b>' });
    await request(service.app)
      .post('/v1/push')
      .send({ device_token: 'device-token-xyz', title: 'Alerta', body: 'Preço atingido' });
    const ui = await request(service.app).get('/ui');
    expect(ui.status).toBe(200);
    for (const text of [
      'Caixa de SMS e push',
      '+5511900000000',
      '&lt;b&gt;oi&lt;/b&gt;',
      'Alerta',
      'https://mail.broker.localhost',
    ]) {
      expect(ui.text).toContain(text);
    }
  });
});
