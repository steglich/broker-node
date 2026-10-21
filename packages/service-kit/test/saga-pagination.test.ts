import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '@broker/ids';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyPage,
  parseEnumList,
  parsePageQuery,
  parsePeriod,
  SagaOrchestrator,
  toPage,
  type SagaDefinition,
} from '../src/index.js';
import { sagaEffectMigration, withdrawalSaga, type WithdrawalData } from './fixtures/sagas.js';
import { pgConfig, serviceDb, sleep, testService } from './helpers.js';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
let sagaDb: Kysely<unknown>;
let pagingDb: Kysely<unknown>;

beforeAll(async () => {
  sagaDb = await serviceDb('saga', sagaEffectMigration);
  pagingDb = await serviceDb('paging', {
    '0001_statement': {
      async up(db: Kysely<unknown>) {
        await sql`CREATE TABLE statement_line (id uuid PRIMARY KEY, account_id text NOT NULL, amount numeric(20,2) NOT NULL, created_at timestamptz NOT NULL)`.execute(
          db,
        );
        await sql`CREATE INDEX statement_line_page ON statement_line (account_id, created_at, id)`.execute(
          db,
        );
      },
    },
  });
});
afterAll(async () => {
  await Promise.all([sagaDb?.destroy(), pagingDb?.destroy()]);
});

const effects = async (sagaId: string) =>
  (
    await sql<{
      step: string;
    }>`SELECT step FROM saga_effect WHERE saga_id = ${sagaId} ORDER BY id`.execute(sagaDb)
  ).rows.map((r) => r.step);

describe('saga orquestrada (RN-PAD-030/031)', () => {
  it('RN-PAD-030: o processo morre no meio de um passo e a saga é retomada após o reinício', async () => {
    const withdrawalId = uuidv7();
    const proc = spawn(
      process.execPath,
      ['--import', 'tsx', '--conditions=source', 'test/fixtures/saga-runner.ts'],
      {
        cwd: pkgDir,
        env: {
          ...process.env,
          SAGA_DB: JSON.stringify(pgConfig('saga', 'app')),
          WITHDRAWAL_ID: withdrawalId,
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    const out: string[] = [];
    proc.stdout.on('data', (c: Buffer) => out.push(c.toString()));
    const signal = await new Promise((r) => proc.on('exit', (_c, s) => r(s)));
    expect(signal).toBe('SIGKILL');
    expect(out.join('')).toContain('IN_TRANSFER');

    const saga = (
      await sql<{ id: string; state: string; step: string; data: WithdrawalData }>`
      SELECT id, state, step, data FROM saga_instance WHERE data->>'withdrawalId' = ${withdrawalId}`.execute(
        sagaDb,
      )
    ).rows[0]!;
    // Estado persistido: o 1º passo terminou (holdId gravado) e a saga parou na transferência.
    expect(saga).toMatchObject({
      state: 'RUNNING',
      step: 'transfer_pix',
      data: { holdId: `hold-${withdrawalId}` },
    });

    // "Reinício": outro orquestrador. Enquanto o lease do passo vale, ninguém pega a saga.
    const orchestrator = new SagaOrchestrator({
      db: sagaDb,
      newId: uuidv7,
      definitions: [withdrawalSaga(sagaDb) as SagaDefinition<never>],
    });
    expect(await orchestrator.resumePending()).toEqual([]);
    await sleep(2200); // lease = timeout do passo (1 s) + 1 s de folga
    expect(await orchestrator.resumePending()).toContain(saga.id);

    expect(await orchestrator.get(saga.id)).toMatchObject({
      state: 'COMPLETED',
      data: { transferId: `e2e-${withdrawalId}` },
    });
    // A transferência rodou de novo (é idempotente); os outros passos, uma vez cada.
    expect(await effects(saga.id)).toEqual([
      'reserve_funds',
      'transfer_pix',
      'transfer_pix',
      'notify',
    ]);
  });

  it('RN-PAD-031: passo que estoura o timeout é repetido; esgotado, compensa os anteriores', async () => {
    let attempts = 0;
    const def = withdrawalSaga(sagaDb, {
      inTransfer: async () => {
        attempts++;
        await sleep(1500); // passa do timeout de 1 s
      },
    });
    def.steps[1]!.maxAttempts = 2;
    const orchestrator = new SagaOrchestrator({
      db: sagaDb,
      newId: uuidv7,
      definitions: [def as SagaDefinition<never>],
    });
    const result = await orchestrator.start('withdrawal', {
      withdrawalId: uuidv7(),
      amount: '10.00',
    });
    expect(attempts).toBe(2);
    expect(result.state).toBe('COMPENSATED');
    expect(await effects(result.id)).toEqual([
      'reserve_funds',
      'transfer_pix',
      'transfer_pix',
      'reserve_funds:release',
    ]);
    expect((result.data as WithdrawalData).holdId).toBeUndefined(); // a reserva foi desfeita
  });

  it('passo não idempotente que falha não é repetido: compensa direto', async () => {
    const def = withdrawalSaga(sagaDb, {
      inTransfer: async () => {
        throw new Error('PIX recusou');
      },
    });
    def.steps[1]!.idempotent = false;
    const orchestrator = new SagaOrchestrator({
      db: sagaDb,
      newId: uuidv7,
      definitions: [def as SagaDefinition<never>],
    });
    const result = await orchestrator.start('withdrawal', {
      withdrawalId: uuidv7(),
      amount: '10.00',
    });
    expect(result.state).toBe('COMPENSATED');
    expect(await effects(result.id)).toEqual([
      'reserve_funds',
      'transfer_pix',
      'reserve_funds:release',
    ]);
  });
});

describe('paginação por cursor, filtros e ordenação (RN-API-020..023)', () => {
  beforeAll(async () => {
    const base = Date.parse('2026-10-01T13:00:00Z');
    for (let i = 0; i < 120; i++) {
      // Vários lançamentos no mesmo instante: o desempate pelo id garante a ordem estável.
      await sql`INSERT INTO statement_line VALUES (${uuidv7()}, 'acc-1', ${`${i}.00`}, ${new Date(base + Math.floor(i / 3) * 60_000).toISOString()})`.execute(
        pagingDb,
      );
    }
  });

  function app() {
    const { service } = testService();
    service.route({
      method: 'get',
      path: '/v1/me/statement',
      auth: 'public',
      handler: async (req) => {
        const page = parsePageQuery(req.query as Record<string, unknown>, {
          sortable: { createdAt: 'created_at', amount: 'amount' },
          defaultSort: '-createdAt',
          overflow: (req.query as Record<string, string>)['strict'] ? 'reject' : 'clamp',
        });
        parsePeriod(
          (req.query as Record<string, unknown>)['from'],
          (req.query as Record<string, unknown>)['to'],
        );
        parseEnumList((req.query as Record<string, unknown>)['type'], 'type', [
          'DEPOSIT',
          'WITHDRAWAL',
        ] as const);
        const rows = await applyPage(
          pagingDb
            .selectFrom('statement_line' as never)
            .selectAll()
            .where('account_id' as never, '=', 'acc-1' as never),
          page,
        ).execute();
        const typed = rows as unknown as Array<{
          id: string;
          created_at: Date;
          amount: { toFixed: (n: number) => string };
        }>;
        const result = toPage(typed, page, (r) => ({
          value: page.sort.column === 'amount' ? r.amount.toFixed(2) : r.created_at.toISOString(),
          id: r.id,
        }));
        return {
          body: {
            items: result.items.map((r) => ({ id: r.id, amount: r.amount.toFixed(2) })),
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
          },
        };
      },
    });
    return service;
  }

  it('RN-API-020/021: limite padrão 50, cursor opaco até o fim, sem repetir nem pular itens', async () => {
    const service = app();
    const seen: string[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    do {
      const res = await request(service.app)
        .get('/v1/me/statement')
        .query(cursor ? { cursor } : {})
        .expect(200);
      sizes.push(res.body.items.length);
      seen.push(...res.body.items.map((i: { id: string }) => i.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([50, 50, 20]);
    expect(new Set(seen).size).toBe(120);
  });

  it('RN-API-023: ordenação só pelos campos permitidos, crescente ou decrescente', async () => {
    const service = app();
    const asc = await request(service.app)
      .get('/v1/me/statement')
      .query({ sort: 'amount', limit: 5 })
      .expect(200);
    expect(asc.body.items.map((i: { amount: string }) => i.amount)).toEqual([
      '0.00',
      '1.00',
      '2.00',
      '3.00',
      '4.00',
    ]);
    const next = await request(service.app)
      .get('/v1/me/statement')
      .query({ sort: 'amount', limit: 5, cursor: asc.body.nextCursor })
      .expect(200);
    expect(next.body.items[0].amount).toBe('5.00');
    const desc = await request(service.app)
      .get('/v1/me/statement')
      .query({ sort: '-amount', limit: 2 })
      .expect(200);
    expect(desc.body.items.map((i: { amount: string }) => i.amount)).toEqual(['119.00', '118.00']);
    const bad = await request(service.app)
      .get('/v1/me/statement')
      .query({ sort: 'accountId' })
      .expect(400);
    expect(bad.body.errors[0]).toMatchObject({ field: 'sort', code: 'INVALID_VALUE' });
  });

  it('spec: limit=500 usa no máximo 200 (ou 400 quando a rota é estrita)', async () => {
    const service = app();
    const clamped = await request(service.app)
      .get('/v1/me/statement')
      .query({ limit: 500 })
      .expect(200);
    expect(clamped.body.items).toHaveLength(120);
    const strict = await request(service.app)
      .get('/v1/me/statement')
      .query({ limit: 500, strict: 1 })
      .expect(400);
    expect(strict.body.errors[0].code).toBe('LIMIT_TOO_LARGE');
  });

  it('RN-API-022: período maior que 1 ano, filtro com valor fora da lista e cursor adulterado → 400', async () => {
    const service = app();
    expect(
      (
        await request(service.app)
          .get('/v1/me/statement')
          .query({ from: '2025-01-01', to: '2026-06-01' })
          .expect(400)
      ).body.errors[0].code,
    ).toBe('PERIOD_TOO_LONG');
    expect(
      (
        await request(service.app)
          .get('/v1/me/statement')
          .query({ type: 'DEPOSIT,BONUS' })
          .expect(400)
      ).body.errors[0].field,
    ).toBe('type');
    expect(
      (
        await request(service.app)
          .get('/v1/me/statement')
          .query({ cursor: 'nao-e-um-cursor' })
          .expect(400)
      ).body.errors[0].code,
    ).toBe('INVALID_CURSOR');
  });
});
