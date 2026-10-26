// 15.1 núcleo do ledger no PostgreSQL (soma zero, idempotência, sequência, append-only, estorno) e
// 15.2 plano de contas (contas da casa por migração, do cliente por account.opened).
import { BusinessDate, Money } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerCash, houseAccount, HOUSE_ACCOUNTS } from '../src/domain/chart.js';
import type { JournalDraft } from '../src/domain/journal.js';
import { app, brl, openClient, outbox, startEnv, stopEnv, type App, type Env } from './helpers.js';

let env: Env;
let a: App;
beforeAll(async () => {
  env = await startEnv();
  a = await app(env);
}, 180_000);
afterAll(() => stopEnv(env));

const today = () => a.clock.now().businessDate();

const transfer = (
  key: string,
  ownerId: string,
  amount: string,
  side: 'CREDIT' | 'DEBIT' = 'CREDIT',
  status: 'PENDING' | 'SETTLED' = 'SETTLED',
  valueDate: BusinessDate = today(),
): JournalDraft => ({
  idempotencyKey: key,
  type: 'ADJUSTMENT',
  referenceType: 'TEST',
  referenceId: key,
  description: `Teste ${key}`,
  bookingDate: today(),
  createdBy: 'test',
  lines: [
    { account: customerCash(ownerId), side, amount: brl(amount), valueDate, status },
    {
      account: houseAccount('CLEARING_HOUSE'),
      side: side === 'CREDIT' ? 'DEBIT' : 'CREDIT',
      amount: brl(amount),
      valueDate,
      status,
    },
  ],
});

const post = (d: JournalDraft, opts = {}) =>
  a.store.transaction((tx) => a.ledger.post(tx, d, opts));

describe('15.2 plano de contas (RN-LED-010/011)', () => {
  it('as contas da casa existem desde a migração, uma vez cada, com a regra de sinal do RN-LED-011', async () => {
    const { rows } = await sql<{ code: string; any_sign: boolean; n: string }>`
      SELECT code, bool_and(any_sign) AS any_sign, count(*) AS n FROM ledger_account
      WHERE owner_id IS NULL GROUP BY code`.execute(env.db);
    expect(rows.map((r) => r.code).sort()).toEqual(HOUSE_ACCOUNTS.map((h) => h.code).sort());
    expect(rows.every((r) => Number(r.n) === 1)).toBe(true);
    expect(rows.find((r) => r.code === 'HOUSE_PIX_RESERVE')!.any_sign).toBe(false);
    expect(rows.find((r) => r.code === 'SMM_CASH')!.any_sign).toBe(true);
  });

  it('account.opened cria CUST_CASH e CUST_CASH_COLLATERAL uma única vez (evento repetido)', async () => {
    const accountId = uuidv7();
    const opened = {
      accountId,
      customerId: uuidv7(),
      accountNumber: '1000002-7',
      openedAt: a.clock.now().toString(),
    };
    const first = await a.store.transaction((tx) => a.accounts.onAccountOpened(tx, opened));
    const again = await a.store.transaction((tx) => a.accounts.onAccountOpened(tx, opened));
    expect([first.created, again.created]).toEqual([2, 0]);
    const { rows } = await sql<{ code: string }>`
      SELECT code FROM ledger_account WHERE owner_id = ${accountId} ORDER BY code`.execute(env.db);
    expect(rows.map((r) => r.code)).toEqual(['CUST_CASH', 'CUST_CASH_COLLATERAL']);
  });

  it('a aplicação não cria conta da casa: o usuário do app não tem como inserir outra com o mesmo código', async () => {
    await expect(
      sql`INSERT INTO ledger_account (id, code, owner_type, owner_id, normal_side, any_sign, created_at)
          VALUES (${uuidv7()}, 'HOUSE_PIX_RESERVE', 'HOUSE', NULL, 'DEBIT', false, now())`.execute(
        env.db,
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe('15.1 journal, idempotência e sequência (RN-LED-001..007)', () => {
  it('LEDGER_UNBALANCED_JOURNAL: débito de 100,00 e crédito de 99,99 não persiste nada', async () => {
    const c = await openClient(a);
    const key = `unbalanced:${uuidv7()}`;
    const bad: JournalDraft = {
      ...transfer(key, c.accountId, '100.00'),
      lines: [
        { ...transfer(key, c.accountId, '100.00').lines[0]!, amount: brl('99.99') },
        transfer(key, c.accountId, '100.00').lines[1]!,
      ],
    };
    await expect(post(bad)).rejects.toMatchObject({ code: 'LEDGER_UNBALANCED_JOURNAL' });
    const { rows } = await sql`SELECT 1 FROM journal WHERE idempotency_key = ${key}`.execute(
      env.db,
    );
    expect(rows).toHaveLength(0);
  });

  it('segunda barreira: o gatilho diferido recusa no commit um journal desbalanceado gravado direto', async () => {
    const c = await openClient(a);
    const cash = (await a.store.transaction((tx) => tx.account(customerCash(c.accountId))))!;
    const jid = uuidv7();
    await expect(
      env.db.transaction().execute(async (trx) => {
        await sql`INSERT INTO journal (id, idempotency_key, type, reference_type, reference_id, description,
                    booking_date, created_by, created_at)
                  VALUES (${jid}, ${`raw:${jid}`}, 'ADJUSTMENT', 'TEST', 'x', 'x', '2026-01-05', 'test', now())`.execute(
          trx,
        );
        await sql`INSERT INTO ledger_entry (id, journal_id, account_id, sequence, amount, currency, value_date,
                    status, posted_at)
                  VALUES (${uuidv7()}, ${jid}, ${cash.id}, 999, 10.00, 'BRL', '2026-01-05', 'SETTLED', now())`.execute(
          trx,
        );
      }),
    ).rejects.toThrow(/LEDGER_UNBALANCED_JOURNAL/);
  });

  it('RN-LED-003: repetir a mesma idempotency_key devolve o lançamento existente', async () => {
    const c = await openClient(a);
    const key = `trade:${uuidv7()}:buyer`;
    const first = await post(transfer(key, c.accountId, '50.00'));
    const again = await post(transfer(key, c.accountId, '50.00'));
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.journal.id).toBe(first.journal.id);
    const { rows } = await sql`SELECT 1 FROM journal WHERE idempotency_key = ${key}`.execute(
      env.db,
    );
    expect(rows).toHaveLength(1);
  });

  it('RN-LED-007: três lançamentos na mesma conta têm sequências consecutivas, também em paralelo', async () => {
    const c = await openClient(a);
    await Promise.all(
      [1, 2, 3].map((i) => post(transfer(`seq:${c.accountId}:${i}`, c.accountId, '10.00'))),
    );
    const { rows } = await sql<{ sequence: bigint }>`
      SELECT e.sequence FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id
      WHERE a.owner_id = ${c.accountId} AND a.code = 'CUST_CASH' ORDER BY e.sequence`.execute(
      env.db,
    );
    expect(rows.map((r) => r.sequence)).toEqual([1n, 2n, 3n]);
  });

  it('propriedade (INV-01): depois de journals aleatórios, cada journal e o ledger inteiro somam zero', async () => {
    const clients = await Promise.all([1, 2, 3].map(() => openClient(a)));
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 2 }),
        fc.bigInt({ min: 1n, max: 1_000_000_00n }),
        fc.boolean(),
        async (who, minor, pending) => {
          const amount = Money.fromMinor(minor, 'BRL').toString();
          await post(
            transfer(
              `prop:${uuidv7()}`,
              clients[who]!.accountId,
              amount,
              'CREDIT',
              pending ? 'PENDING' : 'SETTLED',
              pending ? a.clock.now().businessDate().plusDays(2) : today(),
            ),
          );
        },
      ),
      { numRuns: 25 },
    );
    const perJournal = await sql<{ n: string }>`
      SELECT count(*) AS n FROM (SELECT journal_id FROM ledger_entry GROUP BY journal_id, currency
                                 HAVING sum(amount) <> 0) x`.execute(env.db);
    expect(Number(perJournal.rows[0]!.n)).toBe(0);
    const total = await sql<{
      s: { isZero(): boolean };
    }>`SELECT coalesce(sum(amount), 0) AS s FROM ledger_entry`.execute(env.db);
    expect(total.rows[0]!.s.isZero()).toBe(true);
  });

  it('RN-LED-011: a CUST_CASH não fica negativa por comando do cliente; débito do sistema pode', async () => {
    const c = await openClient(a);
    await expect(
      post(transfer(`neg:${uuidv7()}`, c.accountId, '10.00', 'DEBIT')),
    ).rejects.toMatchObject({
      code: 'LEDGER_SIGN_VIOLATION',
    });
    const fee = await post(transfer(`fee:${uuidv7()}`, c.accountId, '10.00', 'DEBIT'), {
      systemDebit: true,
    });
    expect(fee.created).toBe(true);
    const b = (await a.store.transaction((tx) => a.ledger.balances(tx, c.accountId)))!;
    expect(b.settled.toString()).toBe('-10.00');
    expect(b.withdrawable.toString()).toBe('0.00');
  });

  it('publica ledger.journal_posted com as entradas e ledger.balance_changed particionados pela conta', async () => {
    const c = await openClient(a);
    const posted = await post(transfer(`ev:${uuidv7()}`, c.accountId, '25.00'));
    const journal = (await outbox(env.db, 'ledger.journal_posted')).find(
      (e) => e.payload['journalId'] === posted.journal.id,
    )!;
    expect(journal.partition_key).toBe(c.accountId);
    expect(journal.payload['entries']).toEqual([
      expect.objectContaining({
        accountCode: 'CUST_CASH',
        ownerId: c.accountId,
        amount: '25.00',
        sequence: 1,
      }),
      expect.objectContaining({ accountCode: 'CLEARING_HOUSE', ownerId: null, amount: '-25.00' }),
    ]);
    const balance = (await outbox(env.db, 'ledger.balance_changed')).filter(
      (e) => e.payload['accountId'] === c.accountId,
    );
    expect(balance.at(-1)).toMatchObject({
      partition_key: c.accountId,
      payload: { settled: '25.00', withdrawable: '25.00', lastSequence: 1 },
    });
  });
});

describe('15.1 imutabilidade e estorno (RN-LED-002)', () => {
  it('o usuário da aplicação não altera nem apaga entradas e journals; o dono também é barrado pelo gatilho', async () => {
    const c = await openClient(a);
    const posted = await post(transfer(`imm:${uuidv7()}`, c.accountId, '5.00'));
    const id = posted.entries[0]!.id;
    await expect(
      sql`UPDATE ledger_entry SET amount = 1 WHERE id = ${id}`.execute(env.db),
    ).rejects.toThrow(/permission denied/);
    await expect(sql`DELETE FROM ledger_entry WHERE id = ${id}`.execute(env.db)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      sql`UPDATE journal SET description = 'x' WHERE id = ${posted.journal.id}`.execute(env.db),
    ).rejects.toThrow(/permission denied/);
    await expect(
      sql`UPDATE ledger_entry SET amount = 1 WHERE id = ${id}`.execute(env.owner),
    ).rejects.toThrow(/só PENDING → SETTLED/);
    await expect(
      sql`DELETE FROM journal WHERE id = ${posted.journal.id}`.execute(env.owner),
    ).rejects.toThrow(/append-only/);
  });

  it('PENDING → SETTLED é a única mudança permitida numa entrada (RN-LED-006)', async () => {
    const c = await openClient(a);
    const posted = await post(
      transfer(`pend:${uuidv7()}`, c.accountId, '7.00', 'CREDIT', 'PENDING', today().plusDays(2)),
    );
    const id = posted.entries[0]!.id;
    await sql`UPDATE ledger_entry SET status = 'SETTLED', settled_at = now() WHERE id = ${id}`.execute(
      env.db,
    );
    await expect(
      sql`UPDATE ledger_entry SET status = 'PENDING' WHERE id = ${id}`.execute(env.db),
    ).rejects.toThrow(/só PENDING → SETTLED/);
  });

  it('a correção é um estorno que referencia o original; o original fica intacto; estornar de novo devolve o mesmo', async () => {
    const c = await openClient(a);
    const original = await post(transfer(`orig:${uuidv7()}`, c.accountId, '40.00'));
    const reversal = await a.store.transaction((tx) =>
      a.ledger.reverse(tx, original.journal.id, { createdBy: 'op-1', reason: 'valor errado' }),
    );
    const again = await a.store.transaction((tx) =>
      a.ledger.reverse(tx, original.journal.id, { createdBy: 'op-1', reason: 'valor errado' }),
    );
    expect(reversal.journal).toMatchObject({
      type: 'REVERSAL',
      reversesJournalId: original.journal.id,
    });
    expect(again.journal.id).toBe(reversal.journal.id);
    expect(reversal.entries.map((e) => e.amount.toString())).toEqual(['-40.00', '40.00']);
    const kept = await a.store.transaction((tx) => tx.entriesOf(original.journal.id));
    expect(kept.map((e) => e.amount.toString())).toEqual(['40.00', '-40.00']);
    const b = (await a.store.transaction((tx) => a.ledger.balances(tx, c.accountId)))!;
    expect(b.settled.isZero()).toBe(true);
  });
});
