// customer-service (catálogo de serviços §2): onboarding, cliente, conta, suitability e termos.
import { RealClock, TickedClock, type Clock } from '@broker/clock';
import { Instant } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import {
  BlindIndex,
  createDatabase,
  FieldCipher,
  loadKeyring,
  parseKey,
} from '@broker/persistence';
import {
  Authenticator,
  BaseConfigProperties,
  createLogger,
  loadConfigOrExit,
  RevocationList,
  ServiceTokenProvider,
  SignatureVerifier,
} from '@broker/service-kit';
import { Valkey } from 'iovalkey';
import Type from 'typebox';
import { FieldProtectionAdapter, nodeRandomness } from './adapters/crypto.js';
import { HttpBank, HttpClosureCheck, HttpKycProvider } from './adapters/integrations.js';
import { SmtpAndSinkMessenger } from './adapters/messenger.js';
import { S3DocumentStorage } from './adapters/s3-documents.js';
import { createCustomerService } from './app.js';
import type { ClosureCheck, ClosurePendency } from './application/ports.js';

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
  VALKEY_HOST: Type.String(),
  VALKEY_PORT: Type.Integer({ default: 6379 }),
  VALKEY_PASSWORD: Type.String(),
  CLOCK_MODE: Type.Union(
    [Type.Literal('REAL'), Type.Literal('ACCELERATED'), Type.Literal('VIRTUAL')],
    { default: 'REAL' },
  ),
  CLOCK_START: Type.Optional(Type.String({ format: 'date-time' })),
  FIELD_MASTER_KEY: Type.String(),
  BLIND_INDEX_KEY: Type.String(),
  AUTH_JWKS_URL: Type.String({ default: 'http://identity-service:8080/.well-known/jwks.json' }),
  AUTH_ISSUER: Type.String({ default: 'https://auth.broker.localhost' }),
  AUTH_AUDIENCE: Type.String({ default: 'broker-api' }),
  DOCUMENTS_S3_ENDPOINT: Type.String(),
  /** Endereço do MinIO visto pelo navegador e pelo KYC (vai nas URLs assinadas). */
  DOCUMENTS_S3_PUBLIC_ENDPOINT: Type.Optional(Type.String()),
  DOCUMENTS_S3_ACCESS_KEY: Type.String(),
  DOCUMENTS_S3_SECRET_KEY: Type.String(),
  DOCUMENTS_S3_BUCKET: Type.String({ default: 'documents' }),
  KYC_URL: Type.String({ default: 'http://kyc-simulator:8080' }),
  KYC_WEBHOOK_SECRET: Type.String({ minLength: 16 }),
  PIX_URL: Type.String({ default: 'http://pix-simulator:8080' }),
  SMTP_HOST: Type.String({ default: 'mailpit' }),
  SMTP_PORT: Type.Integer({ default: 1025 }),
  MAIL_FROM: Type.String({ default: 'Broker <cadastro@broker.localhost>' }),
  MESSAGE_SINK_URL: Type.String({ default: 'http://message-sink:8080' }),
  CONSUME_LEDGER_EVENTS: Type.Boolean({ default: false }),
  /** Donos das pendências de encerramento: `LEDGER=http://ledger-service:8080,CUSTODY=...`. */
  CLOSURE_CHECK_URLS: Type.String({ default: '' }),
  /** Credenciais de serviço para as consultas de encerramento (client credentials no identity). */
  SERVICE_TOKEN_URL: Type.String({ default: 'http://identity-service:8080/v1/oauth/token' }),
  SERVICE_CLIENT_ID: Type.String({ default: 'customer-service' }),
  SERVICE_CLIENT_SECRET: Type.String({ default: '' }),
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
const fields = new FieldProtectionAdapter(
  new FieldCipher(await loadKeyring(db, parseKey(config.FIELD_MASTER_KEY, 'FIELD_MASTER_KEY'))),
  new BlindIndex(parseKey(config.BLIND_INDEX_KEY, 'BLIND_INDEX_KEY')),
);
const valkey = new Valkey({
  host: config.VALKEY_HOST,
  port: config.VALKEY_PORT,
  password: config.VALKEY_PASSWORD,
});
const revocation = new RevocationList(valkey);
const jwks = new URL(config.AUTH_JWKS_URL);
const documents = new S3DocumentStorage({
  endpoint: config.DOCUMENTS_S3_ENDPOINT,
  ...(config.DOCUMENTS_S3_PUBLIC_ENDPOINT
    ? { publicEndpoint: config.DOCUMENTS_S3_PUBLIC_ENDPOINT }
    : {}),
  accessKey: config.DOCUMENTS_S3_ACCESS_KEY,
  secretKey: config.DOCUMENTS_S3_SECRET_KEY,
  bucket: config.DOCUMENTS_S3_BUCKET,
});
const messenger = new SmtpAndSinkMessenger({
  smtpHost: config.SMTP_HOST,
  smtpPort: config.SMTP_PORT,
  from: config.MAIL_FROM,
  smsUrl: config.MESSAGE_SINK_URL,
});
const tokens = new ServiceTokenProvider({
  tokenUrl: config.SERVICE_TOKEN_URL,
  clientId: config.SERVICE_CLIENT_ID,
  clientSecret: config.SERVICE_CLIENT_SECRET,
  scopes: ['closure:read'],
  clock,
});
const closureChecks: ClosureCheck[] = config.CLOSURE_CHECK_URLS.split(',')
  .map((p) => p.trim())
  .filter(Boolean)
  .map((pair) => {
    const [source, url] = pair.split('=') as [ClosurePendency['source'], string];
    return new HttpClosureCheck(source, url, tokens);
  });

const app = await createCustomerService({
  config,
  db,
  database,
  logger,
  clock,
  newId: uuidv7,
  fields,
  random: nodeRandomness,
  documents,
  kyc: new HttpKycProvider(config.KYC_URL),
  bank: new HttpBank(config.PIX_URL),
  messenger,
  closureChecks,
  authenticator: new Authenticator({
    jwks,
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
    clock,
    revocation,
  }),
  signatureVerifier: new SignatureVerifier({
    jwks,
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
    clock,
    revocation,
  }),
  kycWebhookSecret: config.KYC_WEBHOOK_SECRET,
  stream: {
    host: config.STREAM_HOST,
    port: config.STREAM_PORT,
    user: config.STREAM_USER,
    password: config.STREAM_PASSWORD,
  },
  consumeLedgerEvents: config.CONSUME_LEDGER_EVENTS,
});

app.service.onShutdown('database', () => db.destroy());
app.service.onShutdown('valkey', async () => valkey.quit());
app.service.onShutdown('documents', async () => documents.destroy());
app.service.onShutdown('messenger', async () => messenger.close());
app.service.onShutdown('customer', () => app.stop());
await app.start();
await app.service.start();
