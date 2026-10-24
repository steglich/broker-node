// audit-service (catálogo de serviços §20): trilha de auditoria imutável e verificável.
import { RealClock, TickedClock, type Clock } from '@broker/clock';
import { Instant } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import { createDatabase } from '@broker/persistence';
import {
  Authenticator,
  BaseConfigProperties,
  createLogger,
  loadConfigOrExit,
} from '@broker/service-kit';
import Type from 'typebox';
import { S3AnchorStorage } from './adapters/s3-anchor-storage.js';
import { createAuditService } from './app.js';

const Config = Type.Object({
  ...BaseConfigProperties,
  DB_HOST: Type.String(),
  DB_PORT: Type.Integer({ default: 5432 }),
  DB_NAME: Type.String(),
  DB_USER: Type.String(),
  DB_PASSWORD: Type.String(),
  STREAM_HOST: Type.String(),
  STREAM_PORT: Type.Integer({ default: 5552 }),
  STREAM_USER: Type.String(),
  STREAM_PASSWORD: Type.String(),
  /** Modo do relógio do ambiente; fora do REAL, o tempo vem dos `clock.ticked` (D15). */
  CLOCK_MODE: Type.Union(
    [Type.Literal('REAL'), Type.Literal('ACCELERATED'), Type.Literal('VIRTUAL')],
    { default: 'REAL' },
  ),
  /** Instante inicial até o primeiro `clock.ticked` (ACCELERATED/VIRTUAL). */
  CLOCK_START: Type.Optional(Type.String({ format: 'date-time' })),
  /** Contextos cujos eventos `auditable` e `audit.*` entram na trilha, separados por vírgula. */
  AUDIT_SOURCE_CONTEXTS: Type.String({ default: '' }),
  /** Storage das âncoras diárias (MinIO, bucket com object lock, RN-AUD-002). */
  ANCHOR_S3_ENDPOINT: Type.String(),
  ANCHOR_S3_ACCESS_KEY: Type.String(),
  ANCHOR_S3_SECRET_KEY: Type.String(),
  ANCHOR_S3_BUCKET: Type.String({ default: 'audit-anchors' }),
  /** Validação dos tokens do backoffice (identity-service, D10). */
  AUTH_JWKS_URL: Type.String(),
  AUTH_ISSUER: Type.String(),
  AUTH_AUDIENCE: Type.String({ default: 'broker-api' }),
});

const config = loadConfigOrExit(Config);
const clock: Clock =
  config.CLOCK_MODE === 'REAL'
    ? new RealClock()
    : new TickedClock(
        config.CLOCK_MODE,
        config.CLOCK_START ? Instant.parse(config.CLOCK_START) : new RealClock().now(),
      );
const logger = createLogger({
  service: config.SERVICE_NAME,
  environment: config.ENVIRONMENT,
  version: config.SERVICE_VERSION,
  level: config.LOG_LEVEL,
  clock,
});
const database = {
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
};
const db = createDatabase(database);
const anchors = new S3AnchorStorage({
  endpoint: config.ANCHOR_S3_ENDPOINT,
  accessKey: config.ANCHOR_S3_ACCESS_KEY,
  secretKey: config.ANCHOR_S3_SECRET_KEY,
  bucket: config.ANCHOR_S3_BUCKET,
});

const app = await createAuditService({
  config,
  db,
  database,
  logger,
  clock,
  newId: uuidv7,
  anchors,
  authenticator: new Authenticator({
    jwks: new URL(config.AUTH_JWKS_URL),
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
    clock,
  }),
  stream: {
    host: config.STREAM_HOST,
    port: config.STREAM_PORT,
    user: config.STREAM_USER,
    password: config.STREAM_PASSWORD,
  },
  sourceContexts: config.AUDIT_SOURCE_CONTEXTS.split(',')
    .map((c) => c.trim())
    .filter(Boolean),
});

app.service.onShutdown('database', () => db.destroy());
app.service.onShutdown('anchors', async () => anchors.destroy());
app.service.onShutdown('audit', () => app.stop());
await app.start();
await app.service.start();
