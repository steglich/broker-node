// 12.3: consulta à trilha só por BO_AUDITOR/BO_ADMIN, por ator, ação, recurso e período, e auditada (RN-AUD-005).
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  app,
  backofficeToken,
  captureAll,
  event,
  reset,
  startEnv,
  stopEnv,
  type Env,
} from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
}, 180_000);
afterAll(() => stopEnv(env));
beforeEach(() => reset(env));

const PERIOD = { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' };

async function seeded() {
  const a = await app(env);
  await captureAll(a, [
    event({
      actor: { type: 'USER', id: 'ana' },
      eventType: 'order.created',
      partitionKey: 'acc-1',
    }),
    event({
      actor: { type: 'USER', id: 'ana' },
      eventType: 'order.cancelled',
      partitionKey: 'acc-1',
      occurredAt: '2026-01-10T12:00:00.000Z',
    }),
    event({
      actor: { type: 'BACKOFFICE', id: 'op-1' },
      eventType: 'audit.customer_viewed',
      auditable: false,
      payload: { resourceType: 'customer', resourceId: 'cus-9', actorRoles: ['BO_SUPPORT'] },
    }),
    event({ actor: { type: 'USER', id: 'bia' }, occurredAt: '2025-12-20T12:00:00.000Z' }),
  ]);
  return a;
}

describe('12.3 consulta restrita e auditada (RN-AUD-005)', () => {
  it('BO_AUDITOR filtra por ator, ação, recurso e período; a consulta vira registro', async () => {
    const a = await seeded();
    const token = await backofficeToken(a.clock, 'auditor-1', ['BO_AUDITOR']);
    const get = (query: Record<string, string>) =>
      request(a.service.app)
        .get('/v1/audit-records')
        .query({ ...PERIOD, ...query })
        .set('Authorization', `Bearer ${token}`)
        .set('User-Agent', 'auditoria-cli/1.0')
        .expect(200);

    const byActor = await get({ actorId: 'ana' });
    expect(byActor.body.items.map((r: { action: string }) => r.action)).toEqual([
      'order.cancelled',
      'order.created',
    ]);
    const byAction = await get({ action: 'order.cancelled' });
    expect(byAction.body.items).toHaveLength(1);
    const byResource = await get({ resourceType: 'customer', resourceId: 'cus-9' });
    expect(byResource.body.items).toMatchObject([
      { actorId: 'op-1', actorRoles: ['BO_SUPPORT'], action: 'audit.customer_viewed' },
    ]);
    // Período: o evento de dezembro fica de fora.
    const byPeriod = await get({ actorId: 'bia' });
    expect(byPeriod.body.items).toEqual([]);

    // Cada consulta gravou um registro com quem consultou, de onde e com quais filtros.
    const queries = (await a.store.recordsFrom(1, 50)).filter(
      (r) => r.action === 'audit.records_queried',
    );
    expect(queries).toHaveLength(4);
    expect(queries[0]).toMatchObject({
      actorType: 'BACKOFFICE',
      actorId: 'auditor-1',
      actorRoles: ['BO_AUDITOR'],
      resourceType: 'audit_record',
      userAgent: 'auditoria-cli/1.0',
      after: { actorId: 'ana', from: '2026-01-01T00:00:00.000Z', limit: 50 },
    });
    expect(queries[0]!.ip).toBeTruthy();
    // E a trilha continua íntegra com os registros das consultas.
    expect(await a.trail.verify()).toMatchObject({ ok: true, head: { seq: 8 } });
  });

  it('BO_ADMIN também consulta, com paginação por cursor', async () => {
    const a = await seeded();
    const token = await backofficeToken(a.clock, 'admin-1', ['BO_ADMIN']);
    const first = await request(a.service.app)
      .get('/v1/audit-records')
      .query({ ...PERIOD, limit: '2' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    // O registro da própria consulta é o mais novo (seq 5).
    expect(first.body.items.map((r: { seq: number }) => r.seq)).toEqual([5, 3]);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await request(a.service.app)
      .get('/v1/audit-records')
      .query({ ...PERIOD, limit: '2', cursor: first.body.nextCursor })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(second.body.items.map((r: { seq: number }) => r.seq)).toEqual([2, 1]);
  });

  it('BO_FINANCE recebe 403 e nada é consultado; sem token, 401', async () => {
    const a = await seeded();
    const token = await backofficeToken(a.clock, 'fin-1', ['BO_FINANCE']);
    const res = await request(a.service.app)
      .get('/v1/audit-records')
      .query(PERIOD)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    await request(a.service.app).get('/v1/audit-records').query(PERIOD).expect(401);
    expect(await a.store.recordsFrom(5, 10)).toEqual([]);
  });

  it('período obrigatório e de até 1 ano', async () => {
    const a = await seeded();
    const token = await backofficeToken(a.clock, 'auditor-1', ['BO_AUDITOR']);
    const call = (query: Record<string, string>) =>
      request(a.service.app)
        .get('/v1/audit-records')
        .query(query)
        .set('Authorization', `Bearer ${token}`);
    expect((await call({ from: PERIOD.from })).status).toBe(400);
    expect((await call({ from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })).status).toBe(
      400,
    );
    expect((await call({ from: PERIOD.to, to: PERIOD.from })).status).toBe(400);
  });
});
