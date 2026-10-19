// One-shot de migração: roda com <svc>_migrator e termina. O serviço só sobe depois dele.
import { connect } from './db.js';

const client = connect();
await client.connect();
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS migration_marker (
      id integer PRIMARY KEY,
      migrated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await client.query(
    `INSERT INTO migration_marker (id) VALUES (1)
     ON CONFLICT (id) DO UPDATE SET migrated_at = now()`,
  );
  console.log('migração concluída');
} finally {
  await client.end();
}
