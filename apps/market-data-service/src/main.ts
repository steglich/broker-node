// market-data-service (catálogo de serviços §5): adaptador da brapi com orçamento, fila única e
// cache; catálogo, histórico diário, Ibovespa e preço de referência.
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
import { fixtureFetch } from './adapters/brapi/fixtures.js';
import { BrapiProvider } from './adapters/brapi/provider.js';
import { FileTokenSource, StaticTokenSource } from './adapters/brapi/tokens.js';
import { ValkeyProviderCache } from './adapters/cache.js';
import { S3RawStorage } from './adapters/raw-storage.js';
import { ReplayProvider } from './adapters/replay-provider.js';
import { createMarketDataService } from './app.js';
import { loadFixture } from './adapters/brapi/fixtures.js';
import type { ProviderCapabilities } from './application/provider.js';

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
  S3_ENDPOINT: Type.String({ default: 'http://minio:9000' }),
  S3_ACCESS_KEY: Type.String({ default: 'broker' }),
  S3_SECRET_KEY: Type.String(),
  S3_RAW_BUCKET: Type.String({ default: 'brapi-raw' }),
  CLOCK_MODE: Type.Union(
    [Type.Literal('REAL'), Type.Literal('ACCELERATED'), Type.Literal('VIRTUAL')],
    { default: 'REAL' },
  ),
  CLOCK_START: Type.Optional(Type.String({ format: 'date-time' })),
  AUTH_JWKS_URL: Type.String({ default: 'http://identity-service:8080/.well-known/jwks.json' }),
  AUTH_ISSUER: Type.String({ default: 'https://auth.broker.localhost' }),
  AUTH_AUDIENCE: Type.String({ default: 'broker-api' }),
  // RN-BRP-095: fixtures por padrão fora de produção simulada; `brapi` só por configuração explícita.
  MARKET_DATA_PROVIDER: Type.Union(
    [Type.Literal('fixture'), Type.Literal('replay'), Type.Literal('brapi')],
    { default: 'fixture' },
  ),
  BRAPI_BASE_URL: Type.String({ default: 'https://brapi.dev/api' }),
  // RN-BRP-090/094: arquivos de segredo (Docker secrets); o segundo é o da rotação.
  BRAPI_TOKEN_FILE: Type.Optional(Type.String()),
  BRAPI_TOKEN_NEXT_FILE: Type.Optional(Type.String()),
  BRAPI_TOKENLESS_SYMBOLS: Type.String({ default: 'PETR4,MGLU3,VALE3,ITUB4' }),
  // Brapi §3.1 (RN-BRP-010): limites do plano em configuração.
  BRAPI_MONTHLY_REQUESTS: Type.Integer({ default: 15000, minimum: 1 }),
  BRAPI_MAX_CONCURRENCY: Type.Integer({ default: 1, minimum: 1 }),
  BRAPI_UPDATE_INTERVAL_MINUTES: Type.Integer({ default: 30, minimum: 1 }),
  BRAPI_SYMBOLS_PER_REQUEST: Type.Integer({ default: 1, minimum: 1 }),
  BRAPI_MAX_HISTORY_RANGE: Type.String({ default: '3mo' }),
  BRAPI_MIN_INTERVAL_MS: Type.Integer({ default: 1000, minimum: 0 }),
  BRAPI_SAFETY_RESERVE_PCT: Type.String({ default: '0.20' }),
  BRAPI_SCHEMA_CHECK_ENABLED: Type.Boolean({ default: false }),
  BRAPI_SCHEMA_CHECK_WEEKDAY: Type.Integer({ default: 1, minimum: 1, maximum: 7 }),
  BRAPI_SCHEMA_CHECK_AT: Type.String({ default: '07:00', pattern: '^\\d{2}:\\d{2}$' }),
  REPLAY_OFFSET_DAYS: Type.Integer({ default: 7, minimum: 0 }),
  // Brapi §8.2: preço sintético.
  SYNTHETIC_NOISE_ENABLED: Type.Boolean({ default: true }),
  SYNTHETIC_JUMP_ALERT_PCT: Type.String({ default: '0.05' }),
  SYNTHETIC_MAX_NOISE_PCT: Type.String({ default: '0.003' }),
  SYNTHETIC_GLIDE_MINUTES: Type.Integer({ default: 5, minimum: 1 }),
  /** Sandbox: todo dia é útil (RN-SBX-002). */
  CALENDAR_ALL_DAYS_BUSINESS: Type.Boolean({ default: false }),
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
const calendar = new TradingCalendar({
  ...b3Calendar2026To2027,
  ...(config.CALENDAR_ALL_DAYS_BUSINESS ? { allDaysBusiness: true } : {}),
});

const capabilities: Omit<ProviderCapabilities, 'tokenlessSymbols'> = {
  symbolsPerRequest: config.BRAPI_SYMBOLS_PER_REQUEST,
  maxHistoryRange: config.BRAPI_MAX_HISTORY_RANGE,
  allowedIntervals: ['1d'],
  dividends: false,
  metered: config.MARKET_DATA_PROVIDER === 'brapi',
};
const tokens =
  config.MARKET_DATA_PROVIDER === 'brapi'
    ? new FileTokenSource(
        [config.BRAPI_TOKEN_FILE, config.BRAPI_TOKEN_NEXT_FILE].filter((f): f is string => !!f),
      )
    : new StaticTokenSource([]);
const brapi = new BrapiProvider({
  baseUrl: config.BRAPI_BASE_URL,
  tokens,
  tokenlessSymbols: config.BRAPI_TOKENLESS_SYMBOLS.split(',').map((s) => s.trim()),
  capabilities,
  clock,
  logger,
  ...(config.MARKET_DATA_PROVIDER === 'brapi'
    ? {}
    : { fetch: fixtureFetch(), name: 'fixture' as const }),
});

const app = await createMarketDataService({
  config,
  db,
  database,
  clock,
  calendar,
  logger,
  newId: uuidv7,
  provider: (store) =>
    config.MARKET_DATA_PROVIDER === 'replay'
      ? new ReplayProvider({
          source: store,
          clock,
          offsetMs: config.REPLAY_OFFSET_DAYS * 86_400_000,
          fallback: brapi,
        })
      : brapi,
  cache: new ValkeyProviderCache(valkey),
  raw: new S3RawStorage({
    endpoint: config.S3_ENDPOINT,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    bucket: config.S3_RAW_BUCKET,
  }),
  plan: {
    updateIntervalMs: config.BRAPI_UPDATE_INTERVAL_MINUTES * 60_000,
    maxHistoryRange: config.BRAPI_MAX_HISTORY_RANGE,
    jumpAlertPct: config.SYNTHETIC_JUMP_ALERT_PCT,
  },
  budgetPolicy: {
    monthlyRequests: config.BRAPI_MONTHLY_REQUESTS,
    safetyReservePct: config.BRAPI_SAFETY_RESERVE_PCT,
  },
  synthetic: {
    noiseEnabled: config.SYNTHETIC_NOISE_ENABLED,
    maxNoise: Number(config.SYNTHETIC_MAX_NOISE_PCT),
    glideMs: config.SYNTHETIC_GLIDE_MINUTES * 60_000,
  },
  queue: {
    maxConcurrency: config.BRAPI_MAX_CONCURRENCY,
    minIntervalMs: config.BRAPI_MIN_INTERVAL_MS,
  },
  schemaCheck: {
    enabled: config.BRAPI_SCHEMA_CHECK_ENABLED,
    weekday: config.BRAPI_SCHEMA_CHECK_WEEKDAY,
    at: config.BRAPI_SCHEMA_CHECK_AT,
    // RN-BRP-100: 2 requisições (cotação de ticker de teste e uma página do catálogo).
    probes: [
      {
        name: 'stocks/quote',
        fetch: async () => (await brapi.getQuote('PETR4')).raw.body,
        expected: loadFixture('quote-petr4').response.body,
      },
      {
        name: 'tickers',
        fetch: async () => (await brapi.listInstruments(1, 1)).raw.body,
        expected: loadFixture('tickers-page-1').response.body,
      },
    ],
  },
  tokenFingerprint: () => brapi.tokenFingerprint(),
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
app.service.onShutdown('market-data', () => app.stop());
await app.start();
await app.service.start();
