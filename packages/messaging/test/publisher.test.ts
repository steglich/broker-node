import { inTransaction } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import Type from 'typebox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  causedBy,
  defineEvent,
  EventPublisher,
  parseEnvelope,
  PublishRejectedError,
} from '../src/index.js';
import { actor, clock, newId, serviceDb } from './helpers.js';

const EntryPosted = defineEvent({
  eventType: 'ledger.entry_posted',
  eventVersion: 1,
  payload: Type.Object({
    accountId: Type.String(),
    amount: Type.String({ pattern: '^-?\\d+\\.\\d{2}$' }),
    note: Type.Optional(Type.String()),
    extra: Type.Optional(Type.Unknown()),
  }),
  auditable: true,
});

let db: Kysely<unknown>;
const publisher = new EventPublisher({
  source: 'ledger-service',
  environment: 'prod',
  clock: clock(),
  newId,
});
const ctx = { partitionKey: 'acc-1', aggregateType: 'account', aggregateId: 'acc-1', actor };
const outboxCount = async () =>
  Number((await sql<{ n: string }>`SELECT count(*) AS n FROM outbox_event`.execute(db)).rows[0]!.n);

beforeAll(async () => {
  db = await serviceDb('publisher');
});
afterAll(async () => {
  await db.destroy();
});

describe('EventPublisher (RN-MSG-B §4)', () => {
  it('ADR-0008: grava o evento na outbox dentro da transação, com os cabeçalhos do envelope', async () => {
    const id = await inTransaction(db, (trx) =>
      publisher.publish(trx, EntryPosted, { accountId: 'acc-1', amount: '10.00' }, ctx),
    );
    const row = (
      await sql<{
        event_type: string;
        partition_key: string;
        headers: Record<string, unknown>;
        occurred_at: Date;
      }>`
      SELECT event_type, partition_key, headers, occurred_at FROM outbox_event WHERE id = ${id}`.execute(
        db,
      )
    ).rows[0]!;
    expect(row.event_type).toBe('ledger.entry_posted');
    expect(row.partition_key).toBe('acc-1');
    expect(row.headers).toMatchObject({
      source: 'ledger-service',
      environment: 'prod',
      correlationId: id,
      auditable: true,
    });
    expect(row.occurred_at.toISOString()).toBe('2026-10-16T13:00:00.000Z'); // relógio do ambiente (RN-MSG-B-011)
  });

  it('ADR-0008: rollback do caso de uso descarta o evento', async () => {
    const before = await outboxCount();
    await expect(
      inTransaction(db, async (trx) => {
        await publisher.publish(trx, EntryPosted, { accountId: 'acc-1', amount: '1.00' }, ctx);
        throw new Error('regra violada depois de publicar');
      }),
    ).rejects.toThrow(/regra violada/);
    expect(await outboxCount()).toBe(before);
  });

  it('RN-MSG-B-014: payload de 300 KB é recusado no produtor, antes da outbox', async () => {
    const before = await outboxCount();
    const big = { accountId: 'acc-1', amount: '1.00', note: 'x'.repeat(300 * 1024) };
    const err = await inTransaction(db, (trx) =>
      publisher.publish(trx, EntryPosted, big, ctx),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishRejectedError);
    expect((err as PublishRejectedError).reason).toBe('PAYLOAD_TOO_LARGE');
    expect(await outboxCount()).toBe(before);
  });

  it('RN-MSG-B-013: dado pessoal no payload é recusado, inclusive aninhado e em outra grafia', async () => {
    for (const extra of [
      { cpf: '52998224725' },
      { holder: { taxId: '52998224725' } },
      [{ TAX_ID: 'x' }],
      { address: {} },
    ]) {
      const err = await inTransaction(db, (trx) =>
        publisher.publish(trx, EntryPosted, { accountId: 'acc-1', amount: '1.00', extra }, ctx),
      ).catch((e: unknown) => e);
      expect((err as PublishRejectedError).reason).toBe('PERSONAL_DATA');
    }
  });

  it('RN-MSG-B-020: payload fora do esquema é recusado', async () => {
    const err = await inTransaction(db, (trx) =>
      publisher.publish(trx, EntryPosted, { accountId: 'acc-1', amount: '10.5' }, ctx),
    ).catch((e: unknown) => e);
    expect((err as PublishRejectedError).reason).toBe('SCHEMA');
    expect((err as Error).message).toMatch(/\/amount/);
  });

  it('INV-07: evento causado por outro mantém o correlationId e aponta o causationId', async () => {
    const parent = { eventId: newId(), correlationId: 'corr-123', traceparent: '00-abc-def-01' };
    const id = await inTransaction(db, (trx) =>
      publisher.publish(
        trx,
        EntryPosted,
        { accountId: 'acc-1', amount: '2.00' },
        causedBy(parent, ctx),
      ),
    );
    const headers = (
      await sql<{
        headers: Record<string, string>;
      }>`SELECT headers FROM outbox_event WHERE id = ${id}`.execute(db)
    ).rows[0]!.headers;
    expect(headers).toMatchObject({
      correlationId: 'corr-123',
      causationId: parent.eventId,
      traceparent: '00-abc-def-01',
    });
  });
});

describe('parseEnvelope no consumo', () => {
  const valid = {
    eventId: '0192a3c0-0000-7000-8000-000000000001',
    eventType: 'ledger.entry_posted',
    eventVersion: 1,
    source: 'ledger-service',
    environment: 'prod',
    occurredAt: '2026-10-16T13:00:00.000Z',
    partitionKey: 'acc-1',
    correlationId: 'c',
    actor,
    auditable: false,
    payload: { accountId: 'acc-1' },
  };

  it('RN-MSG-B-022: aceita campos desconhecidos (tolerant reader)', () => {
    const env = parseEnvelope(
      JSON.stringify({ ...valid, novoCampo: 1, payload: { accountId: 'acc-1', outro: true } }),
      'prod',
    );
    expect(env.payload).toMatchObject({ accountId: 'acc-1', outro: true });
  });

  it('mensagem sem eventId, que não é JSON ou de outro ambiente é erro permanente', () => {
    const { eventId: _omit, ...withoutId } = valid;
    expect(() => parseEnvelope(JSON.stringify(withoutId), 'prod')).toThrow(/eventId/);
    expect(() => parseEnvelope('{', 'prod')).toThrow(/não é JSON/);
    expect(() =>
      parseEnvelope(JSON.stringify({ ...valid, environment: 'sandbox' }), 'prod'),
    ).toThrow(/RN-MSG-B-012/);
  });
});
