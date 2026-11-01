// market-maker-service (catálogo de serviços §10): o Formador de Mercado Simulado. Cotações,
// recotação, varredura, inventário, P&L e kill switch.
import { RealClock, TickedClock, type Clock } from '@broker/clock';
import { Instant } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import { createDatabase } from '@broker/persistence';
import {
  Authenticator,
  BaseConfigProperties,
  createLogger,
  loadConfigOrExit,
  RevocationList,
} from '@broker/service-kit';
import { Valkey } from 'iovalkey';
import Type from 'typebox';
import { createSmmService, DEFAULT_SMM_ACCOUNT_ID } from './app.js';

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
  AUTH_JWKS_URL: Type.String({ default: 'http://identity-service:8080/.well-known/jwks.json' }),
  AUTH_ISSUER: Type.String({ default: 'https://auth.broker.localhost' }),
  AUTH_AUDIENCE: Type.String({ default: 'broker-api' }),
  /** RN-SMM-022: a conta `MARKET_MAKER` do ambiente. */
  SMM_ACCOUNT_ID: Type.String({ format: 'uuid', default: DEFAULT_SMM_ACCOUNT_ID }),
  APPROVAL_TTL_HOURS: Type.Integer({ default: 24, minimum: 1 }),
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

const app = await createSmmService({
  config,
  db,
  database,
  logger,
  clock,
  newId: uuidv7,
  authenticator: new Authenticator({
    jwks: new URL(config.AUTH_JWKS_URL),
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
    clock,
    revocation: new RevocationList(valkey),
  }),
  accountId: config.SMM_ACCOUNT_ID,
  requestTtlHours: config.APPROVAL_TTL_HOURS,
  stream: {
    host: config.STREAM_HOST,
    port: config.STREAM_PORT,
    user: config.STREAM_USER,
    password: config.STREAM_PASSWORD,
  },
});

app.service.onShutdown('smm', () => app.stop());
app.service.onShutdown('connections', async () => {
  await db.destroy();
  await valkey.quit();
});
await app.start();
await app.service.start();
