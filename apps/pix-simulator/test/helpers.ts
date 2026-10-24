import { uuidv7 } from '@broker/ids';
import { createDatabase, migrateToLatest } from '@broker/persistence';
import { createLogger } from '@broker/service-kit';
import { NO_FAULTS } from '@broker/simulator-kit';
import { generateCpf, seededRandom, testClock } from '@broker/testing';
import { databaseConfig, startPostgres, type StartedPostgres } from '@broker/testing/containers';
import { verifyWebhook } from '@broker/webhooks';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { sql } from 'kysely';
import { createPixSimulator } from '../src/app.js';
import { migrations } from '../src/migrations.js';

export const WEBHOOK_SECRET = 'segredo-webhook-pix-teste';

export interface ReceivedWebhook {
  headers: IncomingHttpHeaders;
  // Corpo JSON livre do webhook recebido.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  signatureOk: boolean;
}

/** Postgres do simulador + receptor de webhook da "corretora"; um por arquivo de teste. */
export async function startEnvironment() {
  const pg: StartedPostgres = await startPostgres(['pix']);
  const migrator = createDatabase(databaseConfig(pg, 'pix', 'migrator'));
  await migrateToLatest(migrator, migrations);
  await migrator.destroy();
  const db = createDatabase(databaseConfig(pg, 'pix', 'app'));

  const received: ReceivedWebhook[] = [];
  let clockRef: ReturnType<typeof testClock> | undefined;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const signatureOk = clockRef
        ? verifyWebhook(req.headers, raw, { secret: WEBHOOK_SECRET, clock: clockRef }).ok
        : false;
      received.push({ headers: req.headers, body: JSON.parse(raw), signatureOk });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const webhookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/pix`;

  /** Simulador novo sobre o mesmo banco (zerado), com relógio virtual próprio. */
  async function simulator(options: { environment?: string; start?: string } = {}) {
    // DELETE e não TRUNCATE: o papel <svc>_app só tem DML (RN-DB §2).
    for (const table of ['webhook_delivery', 'pix_transaction', 'charge', 'pix_key', 'account']) {
      await sql`DELETE FROM ${sql.table(table)}`.execute(db);
    }
    received.length = 0;
    const clock = testClock(options.start ?? '2026-03-02T13:00:00Z');
    clockRef = clock;
    const silent = new Writable({ write: (_c, _e, cb) => cb() });
    const logger = createLogger({
      service: 'pix-simulator',
      environment: 'test',
      version: '0',
      level: 'fatal',
      clock,
      destination: silent,
    });
    const environment = options.environment ?? 'prod';
    const random = seededRandom(1);
    const sim = createPixSimulator({
      config: {
        SERVICE_NAME: 'pix-simulator',
        SERVICE_VERSION: '0',
        GIT_COMMIT: 'x',
        ENVIRONMENT: environment,
        PORT: 0,
        LOG_LEVEL: 'fatal',
        SHUTDOWN_TIMEOUT_MS: 0,
      },
      db,
      clock,
      logger,
      behavior: NO_FAULTS,
      newId: uuidv7,
      random: () => random.next(),
      webhook: { url: webhookUrl, secret: WEBHOOK_SECRET },
      bank: {
        defaultInitialBalance: environment === 'sandbox' ? '100000.00' : '10000.00',
        broker: { cnpj: '11222333000181', name: 'Corretora Estudo', initialBalance: '1000000.00' },
      },
    });
    await sim.bank.seed();
    return { ...sim, clock, app: sim.service.app };
  }

  return {
    simulator,
    received,
    db,
    async stop() {
      await new Promise((r) => server.close(r));
      await db.destroy();
      await pg.container.stop();
    },
  };
}

export const newCpf = (seed: number) => generateCpf({ random: seededRandom(seed) });
export const txid = (n: number) => `txid${String(n).padStart(26, '0')}`;
