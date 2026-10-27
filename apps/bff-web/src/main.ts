// bff-web (D9): token handler do canal web e as rotas da Fase 1, atrás do api-gateway.
import { RealClock } from '@broker/clock';
import { uuidv7 } from '@broker/ids';
import { createDatabase, parseKey } from '@broker/persistence';
import {
  Authenticator,
  BaseConfigProperties,
  createLogger,
  loadConfigOrExit,
  RevocationList,
} from '@broker/service-kit';
import { Valkey } from 'iovalkey';
import Type from 'typebox';
import { createBffWeb } from './app.js';

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
  AUTH_JWKS_URL: Type.String({ default: 'http://identity-service:8080/.well-known/jwks.json' }),
  AUTH_ISSUER: Type.String({ default: 'https://auth.broker.localhost' }),
  AUTH_AUDIENCE: Type.String({ default: 'broker-api' }),
  OAUTH_CLIENT_ID: Type.String({ default: 'bff-web' }),
  OAUTH_REDIRECT_URI: Type.String({ default: 'https://app.broker.localhost/auth/callback' }),
  /** HMAC do anti-CSRF e chave AES-256 do cookie de login com MFA pendente (32 bytes em hex). */
  CSRF_SECRET: Type.String(),
  LOGIN_COOKIE_KEY: Type.String(),
  IDENTITY_URL: Type.String({ default: 'http://identity-service:8080' }),
  CUSTOMER_URL: Type.String({ default: 'http://customer-service:8080' }),
  LEDGER_URL: Type.String({ default: 'http://ledger-service:8080' }),
  REFERENCE_DATA_URL: Type.String({ default: 'http://reference-data-service:8080' }),
  MARKET_DATA_URL: Type.String({ default: 'http://market-data-service:8080' }),
  NOTIFICATION_URL: Type.String({ default: 'http://notification-service:8080' }),
});

const config = loadConfigOrExit(Config);
const clock = new RealClock();
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

const app = await createBffWeb({
  config,
  clock,
  logger,
  db,
  database,
  newId: uuidv7,
  authenticator: new Authenticator({
    jwks: new URL(config.AUTH_JWKS_URL),
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
    clock,
    revocation: new RevocationList(valkey),
  }),
  upstreams: {
    identity: config.IDENTITY_URL,
    customer: config.CUSTOMER_URL,
    ledger: config.LEDGER_URL,
    referenceData: config.REFERENCE_DATA_URL,
    marketData: config.MARKET_DATA_URL,
    notification: config.NOTIFICATION_URL,
  },
  clientId: config.OAUTH_CLIENT_ID,
  redirectUri: config.OAUTH_REDIRECT_URI,
  csrfSecret: parseKey(config.CSRF_SECRET, 'CSRF_SECRET'),
  loginKey: parseKey(config.LOGIN_COOKIE_KEY, 'LOGIN_COOKIE_KEY'),
  stream: {
    host: config.STREAM_HOST,
    port: config.STREAM_PORT,
    user: config.STREAM_USER,
    password: config.STREAM_PASSWORD,
  },
});

app.service.onShutdown('database', () => db.destroy());
app.service.onShutdown('valkey', async () => valkey.quit());
app.service.onShutdown('bff', () => app.stop());
await app.start();
await app.service.start();
