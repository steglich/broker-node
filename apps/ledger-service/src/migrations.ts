import { baseMigrations, calendarReplicaMigrations, makeAppendOnly } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { HOUSE_ACCOUNTS } from './domain/chart.js';

const appRole = async (db: Kysely<unknown>) =>
  (
    await sql<{
      role: string;
    }>`SELECT replace(current_user, '_migrator', '_app') AS role`.execute(db)
  ).rows[0]!.role;

/** Migrações do ledger-service: plataforma (outbox, inbox, sagas) e as próprias. */
export const migrations: Record<string, Migration> = {
  ...baseMigrations,
  ...calendarReplicaMigrations,
  '0001_ledger': {
    async up(db: Kysely<unknown>) {
      // Plano de contas (Financeiro §3). `last_sequence` é a sequência por conta (RN-LED-007): a
      // linha é travada (FOR UPDATE) ao lançar, então as sequências saem sem lacunas.
      await sql`
        CREATE TABLE ledger_account (
          id             uuid PRIMARY KEY,
          code           text NOT NULL,
          owner_type     text NOT NULL CHECK (owner_type IN ('CUSTOMER', 'HOUSE', 'SMM')),
          owner_id       uuid,
          currency       char(3) NOT NULL DEFAULT 'BRL',
          normal_side    text NOT NULL CHECK (normal_side IN ('CREDIT', 'DEBIT')),
          any_sign       boolean NOT NULL,
          last_sequence  bigint NOT NULL DEFAULT 0,
          status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED')),
          created_at     timestamptz NOT NULL,
          UNIQUE NULLS NOT DISTINCT (code, owner_id),
          CHECK ((owner_type = 'CUSTOMER') = (owner_id IS NOT NULL))
        )`.execute(db);

      // RN-LED-002/003: append-only, idempotência por chave; um journal só tem um estorno.
      await sql`
        CREATE TABLE journal (
          id                   uuid PRIMARY KEY,
          idempotency_key      text NOT NULL UNIQUE,
          type                 text NOT NULL CHECK (type IN ('TRADE', 'FEES', 'DEPOSIT', 'WITHDRAWAL',
                                 'CORPORATE_ACTION', 'INTEREST', 'CUSTODY_FEE', 'BTC_FEE', 'TAX',
                                 'ADJUSTMENT', 'REVERSAL')),
          reference_type       text NOT NULL,
          reference_id         text NOT NULL,
          description          text NOT NULL,
          booking_date         date NOT NULL,
          reverses_journal_id  uuid UNIQUE REFERENCES journal (id),
          created_by           text NOT NULL,
          created_at           timestamptz NOT NULL,
          CHECK ((type = 'REVERSAL') = (reverses_journal_id IS NOT NULL))
        )`.execute(db);
      await makeAppendOnly(db, 'journal');

      // Convenção de sinal (domain/journal.ts): amount > 0 é crédito ao titular.
      await sql`
        CREATE TABLE ledger_entry (
          id                   uuid PRIMARY KEY,
          journal_id           uuid NOT NULL REFERENCES journal (id),
          account_id           uuid NOT NULL REFERENCES ledger_account (id),
          sequence             bigint NOT NULL CHECK (sequence > 0),
          amount               numeric(18, 2) NOT NULL CHECK (amount <> 0),
          currency             char(3) NOT NULL,
          value_date           date NOT NULL,
          status               text NOT NULL CHECK (status IN ('PENDING', 'SETTLED')),
          settlement_batch_id  uuid,
          settled_at           timestamptz,
          posted_at            timestamptz NOT NULL,
          UNIQUE (account_id, sequence)
        )`.execute(db);
      await sql`CREATE INDEX ledger_entry_value_idx ON ledger_entry (account_id, value_date, status)`.execute(
        db,
      );
      await sql`CREATE INDEX ledger_entry_journal_idx ON ledger_entry (journal_id)`.execute(db);
      await sql`CREATE INDEX ledger_entry_posted_idx ON ledger_entry (account_id, posted_at)`.execute(
        db,
      );

      // Entradas: imutáveis, salvo PENDING → SETTLED (só status, lote e instante) pela liquidação
      // (RN-LED-006). Duas barreiras: permissão por coluna e gatilho.
      const role = await appRole(db);
      await sql`REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entry FROM ${sql.id(role)}`.execute(db);
      await sql`GRANT UPDATE (status, settlement_batch_id, settled_at) ON ledger_entry TO ${sql.id(role)}`.execute(
        db,
      );
      await sql`
        CREATE FUNCTION ledger_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP <> 'UPDATE' THEN
            RAISE EXCEPTION 'ledger_entry é append-only: % não é permitido', TG_OP
              USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF OLD.status <> 'PENDING' OR NEW.status <> 'SETTLED'
             OR (NEW.id, NEW.journal_id, NEW.account_id, NEW.sequence, NEW.amount, NEW.currency,
                 NEW.value_date, NEW.posted_at)
                IS DISTINCT FROM
                (OLD.id, OLD.journal_id, OLD.account_id, OLD.sequence, OLD.amount, OLD.currency,
                 OLD.value_date, OLD.posted_at) THEN
            RAISE EXCEPTION 'ledger_entry: só PENDING → SETTLED é permitido'
              USING ERRCODE = 'insufficient_privilege';
          END IF;
          RETURN NEW;
        END $$`.execute(db);
      await sql`
        CREATE TRIGGER ledger_entry_guard BEFORE UPDATE OR DELETE ON ledger_entry
        FOR EACH ROW EXECUTE FUNCTION ledger_entry_guard()`.execute(db);
      await sql`
        CREATE TRIGGER ledger_entry_guard_truncate BEFORE TRUNCATE ON ledger_entry
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`.execute(db);

      // INV-01 no banco: no commit, todo journal tem ≥ 2 entradas e soma zero por moeda. É a
      // segunda barreira, depois da validação do domínio (buildJournal).
      await sql`
        CREATE FUNCTION journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
          -- A coluna com o id do journal vem por argumento: id em journal, journal_id nas entradas.
          jid uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
          n integer;
        BEGIN
          SELECT count(*) INTO n FROM ledger_entry WHERE journal_id = jid;
          IF n < 2 THEN
            RAISE EXCEPTION 'LEDGER_UNBALANCED_JOURNAL: journal % com % entrada(s)', jid, n
              USING ERRCODE = 'check_violation';
          END IF;
          IF EXISTS (SELECT 1 FROM ledger_entry WHERE journal_id = jid
                     GROUP BY currency HAVING sum(amount) <> 0) THEN
            RAISE EXCEPTION 'LEDGER_UNBALANCED_JOURNAL: journal % não fecha em zero', jid
              USING ERRCODE = 'check_violation';
          END IF;
          RETURN NULL;
        END $$`.execute(db);
      await sql`
        CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON journal
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_balanced('id')`.execute(
        db,
      );
      await sql`
        CREATE CONSTRAINT TRIGGER ledger_entry_balanced AFTER INSERT ON ledger_entry
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_balanced('journal_id')`.execute(
        db,
      );

      // Cópia local da conta de investimento (account.opened / account.status_changed).
      await sql`
        CREATE TABLE customer_account (
          account_id      uuid PRIMARY KEY,
          customer_id     uuid,
          account_number  text,
          status          text NOT NULL,
          opened_at       timestamptz,
          updated_at      timestamptz NOT NULL
        )`.execute(db);
    },
  },
  '0002_house_accounts': {
    // RN-LED-010: as contas da casa nascem aqui, nunca por requisição.
    async up(db: Kysely<unknown>) {
      for (const a of HOUSE_ACCOUNTS) {
        await sql`
          INSERT INTO ledger_account (id, code, owner_type, owner_id, normal_side, any_sign, created_at)
          VALUES (gen_random_uuid(), ${a.code}, ${a.ownerType}, NULL, ${a.normalSide}, ${a.anySign}, now())
          ON CONFLICT (code, owner_id) DO NOTHING`.execute(db);
      }
    },
  },
  '0003_funds': {
    async up(db: Kysely<unknown>) {
      // Depósito (Financeiro §6, RN-DEP-*). `txid` e `end_to_end_id` únicos: a cobrança e o pagamento
      // não se repetem.
      await sql`
        CREATE TABLE deposit_intent (
          id                 uuid PRIMARY KEY,
          account_id         uuid NOT NULL,
          amount             numeric(18, 2) NOT NULL CHECK (amount > 0),
          txid               text NOT NULL UNIQUE,
          pix_copy_paste     text NOT NULL,
          status             text NOT NULL CHECK (status IN ('PENDING', 'PAID', 'CREDITED', 'REFUNDED', 'EXPIRED', 'CANCELED')),
          expires_at         timestamptz NOT NULL,
          payer_tax_id_hash  char(64),
          end_to_end_id      text UNIQUE,
          journal_id         uuid REFERENCES journal (id),
          refund_reason      text,
          paid_at            timestamptz,
          created_at         timestamptz NOT NULL,
          updated_at         timestamptz NOT NULL
        )`.execute(db);
      await sql`CREATE INDEX deposit_account_idx ON deposit_intent (account_id, created_at DESC)`.execute(
        db,
      );
      await sql`CREATE INDEX deposit_pending_idx ON deposit_intent (expires_at) WHERE status = 'PENDING'`.execute(
        db,
      );

      // Devolução a fazer no Banco Simulado: retomável (o webhook responde antes de ela terminar).
      await sql`
        CREATE TABLE pix_refund (
          id              text PRIMARY KEY,
          end_to_end_id   text NOT NULL UNIQUE,
          deposit_id      uuid REFERENCES deposit_intent (id),
          amount          numeric(18, 2) NOT NULL,
          reason          text NOT NULL,
          status          text NOT NULL CHECK (status IN ('PENDING', 'DONE')),
          attempts        integer NOT NULL DEFAULT 0,
          last_error      text,
          return_id       text,
          created_at      timestamptz NOT NULL,
          done_at         timestamptz
        )`.execute(db);
      await sql`CREATE INDEX pix_refund_pending_idx ON pix_refund (created_at) WHERE status = 'PENDING'`.execute(
        db,
      );

      // Cada PIX visto pelo ledger, com o journal que gerou (ou nenhum): base da idempotência do
      // webhook (RN-DEP-005) e da reconciliação (RN-PIXS-002).
      await sql`
        CREATE TABLE pix_transaction_ref (
          end_to_end_id  text PRIMARY KEY,
          kind           text NOT NULL CHECK (kind IN ('DEPOSIT', 'REFUND', 'WITHDRAWAL')),
          amount         numeric(18, 2) NOT NULL,
          deposit_id     uuid,
          withdrawal_id  uuid,
          journal_id     uuid REFERENCES journal (id),
          occurred_at    timestamptz NOT NULL
        )`.execute(db);
      await makeAppendOnly(db, 'pix_transaction_ref');

      // Saque (Financeiro §7): o estado da saga mora na própria linha (tentativas, próxima
      // tentativa, lease), então é retomável depois de um reinício (RN-PAD-030).
      await sql`
        CREATE TABLE withdrawal_request (
          id                uuid PRIMARY KEY,
          account_id        uuid NOT NULL,
          amount            numeric(18, 2) NOT NULL CHECK (amount > 0),
          bank_account_id   uuid NOT NULL,
          status            text NOT NULL CHECK (status IN ('REQUESTED', 'PENDING_REVIEW', 'PROCESSING',
                              'COMPLETED', 'FAILED', 'REJECTED', 'CANCELED')),
          hold_id           uuid,
          hold_settled      boolean NOT NULL DEFAULT true,
          end_to_end_id     text UNIQUE,
          attempts          integer NOT NULL DEFAULT 0,
          first_attempt_at  timestamptz,
          next_attempt_at   timestamptz,
          lease_until       timestamptz,
          failure_reason    text,
          reviewed_by       text,
          journal_id        uuid REFERENCES journal (id),
          requested_at      timestamptz NOT NULL,
          completed_at      timestamptz,
          updated_at        timestamptz NOT NULL
        )`.execute(db);
      await sql`CREATE INDEX withdrawal_account_idx ON withdrawal_request (account_id, requested_at DESC)`.execute(
        db,
      );
      await sql`CREATE INDEX withdrawal_due_idx ON withdrawal_request (next_attempt_at) WHERE status = 'PROCESSING'`.execute(
        db,
      );
      await sql`CREATE INDEX withdrawal_hold_open_idx ON withdrawal_request (id) WHERE NOT hold_settled`.execute(
        db,
      );

      // Adaptador provisório da porta RiskHoldPort (Fase 1): holds de saque no próprio ledger.
      await sql`
        CREATE TABLE withdrawal_hold (
          id          uuid PRIMARY KEY,
          account_id  uuid NOT NULL,
          amount      numeric(18, 2) NOT NULL CHECK (amount > 0),
          status      text NOT NULL CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED')),
          created_at  timestamptz NOT NULL,
          updated_at  timestamptz NOT NULL
        )`.execute(db);
      await sql`CREATE INDEX withdrawal_hold_active_idx ON withdrawal_hold (account_id) WHERE status = 'ACTIVE'`.execute(
        db,
      );

      // Reconciliação PIX diária (RN-PIXS-002): uma por data, janela contínua com a anterior.
      await sql`
        CREATE TABLE pix_reconciliation (
          id             uuid PRIMARY KEY,
          business_date  date NOT NULL UNIQUE,
          period_from    timestamptz NOT NULL,
          period_to      timestamptz NOT NULL,
          status         text NOT NULL CHECK (status IN ('OK', 'DIVERGENT')),
          checked        integer NOT NULL,
          divergences    jsonb NOT NULL,
          created_at     timestamptz NOT NULL
        )`.execute(db);
    },
  },
};
