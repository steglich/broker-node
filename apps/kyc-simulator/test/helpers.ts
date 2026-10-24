import {
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { uuidv7 } from '@broker/ids';
import { createDatabase, migrateToLatest } from '@broker/persistence';
import { createLogger } from '@broker/service-kit';
import { NO_FAULTS } from '@broker/simulator-kit';
import { seededRandom, testClock } from '@broker/testing';
import { databaseConfig, startMinio, startPostgres } from '@broker/testing/containers';
import { verifyWebhook } from '@broker/webhooks';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { sql } from 'kysely';
import { createKycSimulator } from '../src/app.js';
import { migrations } from '../src/migrations.js';

export const WEBHOOK_SECRET = 'segredo-webhook-kyc-teste';
export const RESULT_DELAY_MS = 2_000;

/** PNG mínimo com o cabeçalho IHDR (largura × altura): o simulador lê só o cabeçalho. */
export function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(2048, 7)]);
}

export interface ReceivedWebhook {
  headers: IncomingHttpHeaders;
  // Corpo JSON livre do webhook recebido.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  signatureOk: boolean;
}

export async function startEnvironment() {
  const [pg, minio] = await Promise.all([startPostgres(['kyc']), startMinio()]);
  const migrator = createDatabase(databaseConfig(pg, 'kyc', 'migrator'));
  await migrateToLatest(migrator, migrations);
  await migrator.destroy();
  const db = createDatabase(databaseConfig(pg, 'kyc', 'app'));

  // O "storage do núcleo": bucket documents, como no ambiente local.
  const s3 = new S3Client({
    endpoint: minio.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: minio.accessKey, secretAccessKey: minio.secretKey },
  });
  await s3.send(new CreateBucketCommand({ Bucket: 'documents' }));
  async function upload(key: string, body: Buffer, expiresIn = 600): Promise<string> {
    await s3.send(new PutObjectCommand({ Bucket: 'documents', Key: key, Body: body }));
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: 'documents', Key: key }), { expiresIn });
  }

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
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const webhookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/kyc`;

  async function simulator() {
    for (const table of ['webhook_delivery', 'kyc_check'])
      await sql`DELETE FROM ${sql.table(table)}`.execute(db);
    received.length = 0;
    const clock = testClock('2026-03-02T13:00:00Z');
    clockRef = clock;
    const silent = new Writable({ write: (_c, _e, cb) => cb() });
    const logger = createLogger({
      service: 'kyc-simulator',
      environment: 'test',
      version: '0',
      level: 'fatal',
      clock,
      destination: silent,
    });
    const random = seededRandom(42);
    const sim = createKycSimulator({
      config: {
        SERVICE_NAME: 'kyc-simulator',
        SERVICE_VERSION: '0',
        GIT_COMMIT: 'x',
        ENVIRONMENT: 'test',
        PORT: 0,
        LOG_LEVEL: 'fatal',
        SHUTDOWN_TIMEOUT_MS: 0,
      },
      db,
      clock,
      logger,
      behavior: NO_FAULTS,
      resultDelay: { kind: 'fixed', ms: RESULT_DELAY_MS },
      newId: uuidv7,
      random: () => random.next(),
      webhook: { url: webhookUrl, secret: WEBHOOK_SECRET },
    });
    /** Avança o relógio até o resultado, processa e entrega os webhooks. */
    async function complete() {
      clock.advanceBy(RESULT_DELAY_MS);
      const processed = await sim.provider.runDue();
      await sim.dispatcher.runDue(100);
      return processed;
    }
    return { ...sim, clock, app: sim.service.app, complete };
  }

  return {
    simulator,
    upload,
    received,
    db,
    async stop() {
      await new Promise((r) => server.close(r));
      await db.destroy();
      await Promise.all([pg.container.stop(), minio.container.stop()]);
    },
  };
}
