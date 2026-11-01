// trading-session-service (catálogo de serviços §6): fases do mercado e dos instrumentos, leilões
// programados, suspensões, circuit breaker e preço de fechamento.
import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
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
import { createSessionService } from './app.js';

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
  // RN-AUC-003.
  AUCTION_MAX_EXTENSIONS: Type.Integer({ default: 3, minimum: 0 }),
  AUCTION_EXTENSION_POLICY: Type.Union(
    [Type.Literal('CONCLUDE_AT_BAND'), Type.Literal('KEEP_OPEN')],
    { default: 'CONCLUDE_AT_BAND' },
  ),
  // RN-CB-002 e RN-FCH-003.
  CIRCUIT_BREAKER_BLACKOUT_MINUTES: Type.Integer({ default: 30, minimum: 0 }),
  CLOSE_DIVERGENCE_ALERT_PCT: Type.String({ default: '0.05' }),
  /** Pregão §5: minutos sem nada do Market Data até suspender; 0 desliga. */
  MARKET_DATA_OUTAGE_MINUTES: Type.Integer({ default: 10, minimum: 0 }),
  APPROVAL_TTL_HOURS: Type.Integer({ default: 24, minimum: 1 }),
  /** RN-SBX-005: comandos de teste; ligado só no sandbox. */
  SANDBOX_COMMANDS_ENABLED: Type.Boolean({ default: false }),
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

const app = await createSessionService({
  config,
  db,
  database,
  logger,
  clock,
  calendar: new TradingCalendar(b3Calendar2026To2027),
  newId: uuidv7,
  authenticator: new Authenticator({
    jwks: new URL(config.AUTH_JWKS_URL),
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
    clock,
    revocation: new RevocationList(valkey),
  }),
  params: {
    maxAuctionExtensions: config.AUCTION_MAX_EXTENSIONS,
    auctionExtensionPolicy: config.AUCTION_EXTENSION_POLICY,
    circuitBreakerBlackoutMinutes: config.CIRCUIT_BREAKER_BLACKOUT_MINUTES,
    closeDivergenceAlertPct: config.CLOSE_DIVERGENCE_ALERT_PCT,
    marketDataOutageMinutes: config.MARKET_DATA_OUTAGE_MINUTES,
    requestTtlHours: config.APPROVAL_TTL_HOURS,
  },
  sandboxCommands: config.SANDBOX_COMMANDS_ENABLED,
  stream: {
    host: config.STREAM_HOST,
    port: config.STREAM_PORT,
    user: config.STREAM_USER,
    password: config.STREAM_PASSWORD,
  },
});

app.service.onShutdown('session', () => app.stop());
app.service.onShutdown('connections', async () => {
  await db.destroy();
  await valkey.quit();
});
await app.start();
await app.service.start();
