// notification-service (catálogo de serviços §17): catálogo, templates, preferências, central
// in-app e entrega por canal (Mailpit e message-sink no local).
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
} from '@broker/service-kit';
import { Valkey } from 'iovalkey';
import Type from 'typebox';
import {
  FieldTokenProtection,
  HttpMessageSink,
  HttpRecipientDirectory,
  SmtpEmailSender,
} from './adapters/integrations.js';
import { createNotificationService } from './app.js';

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
  /** Cifra do token de push (RN-DB-031) e HMAC para achar o mesmo aparelho. */
  FIELD_MASTER_KEY: Type.String(),
  BLIND_INDEX_KEY: Type.String(),
  AUTH_JWKS_URL: Type.String({ default: 'http://identity-service:8080/.well-known/jwks.json' }),
  AUTH_ISSUER: Type.String({ default: 'https://auth.broker.localhost' }),
  AUTH_AUDIENCE: Type.String({ default: 'broker-api' }),
  CUSTOMER_URL: Type.String({ default: 'http://customer-service:8080' }),
  SERVICE_TOKEN_URL: Type.String({ default: 'http://identity-service:8080/v1/oauth/token' }),
  SERVICE_CLIENT_ID: Type.String({ default: 'notification-service' }),
  SERVICE_CLIENT_SECRET: Type.String({ default: '' }),
  SMTP_HOST: Type.String({ default: 'mailpit' }),
  SMTP_PORT: Type.Integer({ default: 1025 }),
  MAIL_FROM: Type.String({ default: 'Broker <avisos@broker.localhost>' }),
  MESSAGE_SINK_URL: Type.String({ default: 'http://message-sink:8080' }),
  APP_URL: Type.String({ default: 'https://app.broker.localhost' }),
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
const valkey = new Valkey({
  host: config.VALKEY_HOST,
  port: config.VALKEY_PORT,
  password: config.VALKEY_PASSWORD,
});
const tokens = new ServiceTokenProvider({
  tokenUrl: config.SERVICE_TOKEN_URL,
  clientId: config.SERVICE_CLIENT_ID,
  clientSecret: config.SERVICE_CLIENT_SECRET,
  scopes: ['customer:notification-recipients'],
  clock,
});
const email = new SmtpEmailSender({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  from: config.MAIL_FROM,
});

const app = await createNotificationService({
  config,
  db,
  database,
  logger,
  clock,
  newId: uuidv7,
  recipients: new HttpRecipientDirectory(config.CUSTOMER_URL, tokens),
  email,
  sink: new HttpMessageSink(config.MESSAGE_SINK_URL),
  tokens: new FieldTokenProtection(
    new FieldCipher(await loadKeyring(db, parseKey(config.FIELD_MASTER_KEY, 'FIELD_MASTER_KEY'))),
    new BlindIndex(parseKey(config.BLIND_INDEX_KEY, 'BLIND_INDEX_KEY')),
  ),
  appUrl: config.APP_URL,
  authenticator: new Authenticator({
    jwks: new URL(config.AUTH_JWKS_URL),
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
    clock,
    revocation: new RevocationList(valkey),
  }),
  stream: {
    host: config.STREAM_HOST,
    port: config.STREAM_PORT,
    user: config.STREAM_USER,
    password: config.STREAM_PASSWORD,
  },
});

app.service.onShutdown('database', () => db.destroy());
app.service.onShutdown('valkey', async () => valkey.quit());
app.service.onShutdown('smtp', async () => email.close());
app.service.onShutdown('notification', () => app.stop());
await app.start();
await app.service.start();
