// Relógio do ambiente e reconciliações, para os E2E (RN-CLK-002, RN-QA-010).
import pg from 'pg';
import { expectStatus, http, ports, secret, urls } from './edge.js';

export interface ClockView {
  mode: 'REAL' | 'ACCELERATED' | 'VIRTUAL';
  now: string;
}

export const environmentClock = async (): Promise<ClockView> =>
  expectStatus(await http<ClockView>(`${urls.scheduler}/v1/clock`), 200).body;

/**
 * `advance_to(t)` (só em VIRTUAL): o agendador anda até `t` publicando `clock.ticked`, e cada
 * serviço segue o relógio quando consome o tick. O relógio não volta: se já passou de `t`, fica.
 */
export async function advanceClock(to: Date): Promise<ClockView> {
  const current = await environmentClock();
  if (Date.parse(current.now) >= to.getTime()) return current;
  return expectStatus(
    await http<ClockView>(`${urls.scheduler}/v1/clock/advance`, {
      method: 'POST',
      body: { to: to.toISOString() },
    }),
    200,
  ).body;
}

/**
 * INV-01 (Mapa de domínios §5): a soma de todos os lançamentos do ledger é zero por moeda, e cada
 * journal fecha em zero. Lê o banco do ledger com a credencial da aplicação (só leitura aqui) até
 * a rotina de integridade existir (Fase 7).
 */
export async function verifyInv01(): Promise<{ entries: number; journals: number }> {
  const client = new pg.Client({
    host: 'localhost',
    port: ports.postgres,
    database: 'ledger',
    user: 'ledger_app',
    password: secret('db/ledger_app'),
  });
  await client.connect();
  try {
    const totals = await client.query<{ currency: string; total: string; entries: string }>(
      'SELECT currency, SUM(amount)::text AS total, COUNT(*)::text AS entries FROM ledger_entry GROUP BY currency',
    );
    const unbalanced = await client.query<{ journal_id: string }>(
      `SELECT journal_id FROM ledger_entry GROUP BY journal_id, currency HAVING SUM(amount) <> 0`,
    );
    const journals = await client.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM journal');
    const off = totals.rows.filter((r) => Number(r.total) !== 0);
    if (off.length || unbalanced.rows.length)
      throw new Error(
        `INV-01 violado: totais ${JSON.stringify(off)}, journals desbalanceados ${JSON.stringify(unbalanced.rows)}`,
      );
    return {
      entries: totals.rows.reduce((n, r) => n + Number(r.entries), 0),
      journals: Number(journals.rows[0]!.n),
    };
  } finally {
    await client.end();
  }
}
