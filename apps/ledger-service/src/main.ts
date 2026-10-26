// ledger-service (catálogo de serviços §3): ledger, saldos, depósito e saque PIX, extrato.
import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
import { RealClock, TickedClock, type Clock } from '@broker/clock';
import { Instant, Money } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import { BlindIndex, createDatabase, parseKey } from '@broker/persistence';
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
import { HttpCustomerDirectory, HttpPixGateway } from './adapters/integrations.js';
import { createLedgerService } from './app.js';
import { DEFAULT_DEPOSIT_EXPIRY_SECONDS } from './domain/deposit.js';

const MoneyText = (dflt: string) => Type.String({ pattern: '^\\d+(\\.\\d{1,2})?$', default: dflt });

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
  /** HMAC do CPF do pagador do depósito (RN-DB-031). */
  BLIND_INDEX_KEY: Type.String(),
  AUTH_JWKS_URL: Type.String({ default: 'http://identity-service:8080/.well-known/jwks.json' }),
  AUTH_ISSUER: Type.String({ default: 'https://auth.broker.localhost' }),
  AUTH_AUDIENCE: Type.String({ default: 'broker-api' }),
  PIX_URL: Type.String({ default: 'http://pix-simulator:8080' }),
  PIX_WEBHOOK_SECRET: Type.String({ minLength: 16 }),
  CUSTOMER_URL: Type.String({ default: 'http://customer-service:8080' }),
  CONSUME_CUSTOMER_EVENTS: Type.Boolean({ default: true }),
  SERVICE_TOKEN_URL: Type.String({ default: 'http://identity-service:8080/v1/oauth/token' }),
  SERVICE_CLIENT_ID: Type.String({ default: 'ledger-service' }),
  SERVICE_CLIENT_SECRET: Type.String({ default: '' }),
  // Parâmetros do Financeiro §6.2 e §7.2.
  DEPOSIT_MIN: MoneyText('1.00'),
  DEPOSIT_MAX: MoneyText('1000000.00'),
  DEPOSIT_EXPIRY_SECONDS: Type.Integer({ default: DEFAULT_DEPOSIT_EXPIRY_SECONDS, minimum: 60 }),
  WITHDRAWAL_MIN: MoneyText('1.00'),
  WITHDRAWAL_DAILY_LIMIT: MoneyText('100000.00'),
  WITHDRAWAL_NIGHTLY_LIMIT: MoneyText('1000.00'),
  WITHDRAWAL_NIGHT_START: Type.String({ pattern: '^\\d{2}:\\d{2}$', default: '20:00' }),
  WITHDRAWAL_NIGHT_END: Type.String({ pattern: '^\\d{2}:\\d{2}$', default: '06:00' }),
  WITHDRAWAL_REVIEW_ABOVE: MoneyText('50000.00'),
  WITHDRAWAL_MAX_ATTEMPTS: Type.Integer({ default: 5, minimum: 1 }),
  WITHDRAWAL_RETRY_WINDOW_MINUTES: Type.Integer({ default: 30, minimum: 1 }),
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
const revocation = new RevocationList(valkey);
const jwks = new URL(config.AUTH_JWKS_URL);
const index = new BlindIndex(parseKey(config.BLIND_INDEX_KEY, 'BLIND_INDEX_KEY'));
const tokens = new ServiceTokenProvider({
  tokenUrl: config.SERVICE_TOKEN_URL,
  clientId: config.SERVICE_CLIENT_ID,
  clientSecret: config.SERVICE_CLIENT_SECRET,
  scopes: ['customer:eligibility', 'customer:holder', 'customer:withdrawal-accounts'],
  clock,
});
const brl = (v: string) => Money.of(v, 'BRL');

const app = await createLedgerService({
  config,
  db,
  database,
  logger,
  clock,
  // A semente do calendário B3; a cópia alimentada por `calendar.updated` chega com o
  // reference-data-service (grupo 16).
  calendar: new TradingCalendar(b3Calendar2026To2027),
  newId: uuidv7,
  pix: new HttpPixGateway(config.PIX_URL),
  customers: new HttpCustomerDirectory(config.CUSTOMER_URL, tokens),
  taxIds: { hash: (taxId) => index.hash(taxId, 'payer_tax_id') },
  depositRules: {
    min: brl(config.DEPOSIT_MIN),
    max: brl(config.DEPOSIT_MAX),
    expiresInSeconds: config.DEPOSIT_EXPIRY_SECONDS,
  },
  withdrawalRules: {
    min: brl(config.WITHDRAWAL_MIN),
    daily: brl(config.WITHDRAWAL_DAILY_LIMIT),
    nightly: brl(config.WITHDRAWAL_NIGHTLY_LIMIT),
    nightStart: config.WITHDRAWAL_NIGHT_START,
    nightEnd: config.WITHDRAWAL_NIGHT_END,
    reviewAbove: brl(config.WITHDRAWAL_REVIEW_ABOVE),
    maxAttempts: config.WITHDRAWAL_MAX_ATTEMPTS,
    retryWindowMs: config.WITHDRAWAL_RETRY_WINDOW_MINUTES * 60_000,
  },
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
  pixWebhookSecret: config.PIX_WEBHOOK_SECRET,
  stream: {
    host: config.STREAM_HOST,
    port: config.STREAM_PORT,
    user: config.STREAM_USER,
    password: config.STREAM_PASSWORD,
  },
  consumeCustomerEvents: config.CONSUME_CUSTOMER_EVENTS,
});

app.service.onShutdown('database', () => db.destroy());
app.service.onShutdown('valkey', async () => valkey.quit());
app.service.onShutdown('ledger', () => app.stop());
await app.start();
await app.service.start();
