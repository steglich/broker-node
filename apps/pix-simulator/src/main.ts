// Banco Simulado (PIX), Sistemas simulados §2. Serviço separado, com banco e API próprios (RN-SIM-001).
import { RealClock } from '@broker/clock';
import { uuidv7 } from '@broker/ids';
import { createDatabase } from '@broker/persistence';
import { BaseConfigProperties, createLogger, loadConfigOrExit } from '@broker/service-kit';
import { behaviorFromConfig, SimulatorConfigProperties } from '@broker/simulator-kit';
import Type from 'typebox';
import { createPixSimulator } from './app.js';

const Config = Type.Object({
  ...BaseConfigProperties,
  ...SimulatorConfigProperties,
  DB_HOST: Type.String(),
  DB_PORT: Type.Integer({ default: 5432 }),
  DB_NAME: Type.String(),
  DB_USER: Type.String(),
  DB_PASSWORD: Type.String(),
  /** Endpoint da corretora para `pix.recebido` (o adaptador do ledger, quando existir). */
  WEBHOOK_URL: Type.String({ default: 'http://ledger-service:8080/webhooks/pix-simulator' }),
  WEBHOOK_SECRET: Type.String({ minLength: 16 }),
  /** Saldo de abertura padrão (§2.1); sem ele, R$ 100.000,00 no sandbox e R$ 10.000,00 nos demais. */
  DEFAULT_INITIAL_BALANCE: Type.Optional(Type.String({ pattern: '^\\d+\\.\\d{2}$' })),
  BROKER_CNPJ: Type.String({ pattern: '^\\d{14}$', default: '11222333000181' }),
  BROKER_NAME: Type.String({ default: 'Corretora Estudo' }),
  BROKER_INITIAL_BALANCE: Type.String({ pattern: '^\\d+\\.\\d{2}$', default: '1000000.00' }),
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
const db = createDatabase({
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
});

const { service, bank, dispatcher } = createPixSimulator({
  config,
  db,
  clock,
  logger,
  behavior: behaviorFromConfig(config),
  newId: uuidv7,
  webhook: { url: config.WEBHOOK_URL, secret: config.WEBHOOK_SECRET },
  bank: {
    defaultInitialBalance:
      config.DEFAULT_INITIAL_BALANCE ??
      (config.ENVIRONMENT === 'sandbox' ? '100000.00' : '10000.00'),
    broker: {
      cnpj: config.BROKER_CNPJ,
      name: config.BROKER_NAME,
      initialBalance: config.BROKER_INITIAL_BALANCE,
    },
  },
});

await bank.seed();
dispatcher.start();
service.onShutdown('database', () => db.destroy());
service.onShutdown('webhooks', () => dispatcher.stop());
await service.start();
