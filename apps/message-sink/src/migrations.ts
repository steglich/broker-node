import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

export const migrations: Record<string, Migration> = {
  '0001_message': {
    async up(db: Kysely<unknown>) {
      await sql`
        CREATE TABLE message (
          id          uuid PRIMARY KEY,
          channel     text NOT NULL CHECK (channel IN ('SMS', 'PUSH')),
          recipient   text NOT NULL,
          title       text,
          body        text NOT NULL,
          data        jsonb NOT NULL DEFAULT '{}',
          status      text NOT NULL CHECK (status IN ('DELIVERED', 'FAILED')),
          error       text,
          created_at  timestamptz NOT NULL
        )`.execute(db);
      await sql`CREATE INDEX message_recipient_idx ON message (recipient, created_at)`.execute(db);
    },
  },
};
