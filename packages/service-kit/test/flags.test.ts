import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FeatureFlags,
  featureFlagMigrations,
  parseFeatureFlags,
  type Service,
} from '../src/index.js';
import { serviceDb, testService } from './helpers.js';

let db: Kysely<unknown>;

beforeAll(async () => {
  db = await serviceDb('flags', featureFlagMigrations);
});
afterAll(() => db?.destroy());

function app(env: string): Service {
  const flags = new FeatureFlags({ defaults: parseFeatureFlags(env), db, cacheTtlMs: 0 });
  const { service } = testService({ flags });
  service.route({
    method: 'get',
    path: '/v1/me/btc/offers',
    auth: 'public',
    flag: 'btc_enabled',
    handler: async () => ({ body: { items: [] } }),
  });
  // Rota pública sem login, mas a flag pode ser sobrescrita por conta quando há uma (aqui via header de teste).
  service.route({
    method: 'get',
    path: '/v1/accounts/:accountId/btc/offers',
    auth: 'public',
    handler: async (req) => {
      await flags.assertEnabled('btc_enabled', (req.params as { accountId: string }).accountId);
      return { body: { items: [] } };
    },
  });
  return service;
}

describe('feature flags (RN-PAD-072)', () => {
  it('spec: com btc_enabled = false, a rota recusa com funcionalidade indisponível', async () => {
    const res = await request(app('{"btc_enabled":false}').app)
      .get('/v1/me/btc/offers')
      .expect(403);
    expect(res.body).toMatchObject({
      code: 'FEATURE_UNAVAILABLE',
      title: 'Funcionalidade indisponível',
      context: { flag: 'btc_enabled' },
    });
  });

  it('ligada no ambiente, a rota funciona; flag desconhecida conta como desligada', async () => {
    await request(app('{"btc_enabled":true}').app).get('/v1/me/btc/offers').expect(200);
    await request(app('{}').app).get('/v1/me/btc/offers').expect(403);
  });

  it('RN-PAD-072: a sobrescrita por conta liga a funcionalidade só para aquela conta', async () => {
    await sql`INSERT INTO feature_flag_override (flag, account_id, enabled, reason) VALUES ('btc_enabled', 'acc-beta', true, 'piloto')`.execute(
      db,
    );
    const service = app('{"btc_enabled":false}');
    await request(service.app).get('/v1/accounts/acc-beta/btc/offers').expect(200);
    await request(service.app).get('/v1/accounts/acc-other/btc/offers').expect(403);
  });

  it('FEATURE_FLAGS inválido falha na leitura da configuração', () => {
    expect(() => parseFeatureFlags('{"btc_enabled":"sim"}')).toThrow(/true ou false/);
    expect(() => parseFeatureFlags('[1]')).toThrow(/objeto JSON/);
  });
});
