// Casos de teste das regras de .semgrep/broker.yml (semgrep --test). Não é código do projeto.
declare const sql: { raw(s: string): unknown };
declare const client: { query(text: string, values?: unknown[]): unknown };
declare const table: string;
declare const id: string;

// ruleid: kysely-sql-raw-dynamic
sql.raw(`SELECT * FROM ${table}`);
// ok: kysely-sql-raw-dynamic
sql.raw('SELECT 1');

// ruleid: pg-query-template-interpolation
client.query(`SELECT * FROM account WHERE id = '${id}'`);
// ok: pg-query-template-interpolation
client.query('SELECT * FROM account WHERE id = $1', [id]);

// ruleid: tls-verification-disabled
const agent = { host: 'bank', rejectUnauthorized: false };
// ok: tls-verification-disabled
const safe = { host: 'bank', rejectUnauthorized: true };

declare const signature: string;
declare const expected: string;
// ruleid: webhook-signature-non-constant-compare
if (signature === expected) console.log(agent, safe);
