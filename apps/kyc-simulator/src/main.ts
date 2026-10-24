// Provedor de KYC simulado (Sistemas simulados §3). Serviço separado, com banco e API próprios (RN-SIM-001).
import { RealClock } from '@broker/clock';
import { uuidv7 } from '@broker/ids';
import { createDatabase } from '@broker/persistence';
import { BaseConfigProperties, createLogger, loadConfigOrExit } from '@broker/service-kit';
import { behaviorFromConfig, parseLatency, SimulatorConfigProperties } from '@broker/simulator-kit';
import Type from 'typebox';
import { createKycSimulator } from './app.js';

const Config = Type.Object({
  ...BaseConfigProperties,
  ...SimulatorConfigProperties,
  DB_HOST: Type.String(),
  DB_PORT: Type.Integer({ default: 5432 }),
  DB_NAME: Type.String(),
  DB_USER: Type.String(),
  DB_PASSWORD: Type.String(),
  /** Endpoint do customer-service para os resultados. */
  WEBHOOK_URL: Type.String({ default: 'http://customer-service:8080/webhooks/kyc-simulator' }),
  WEBHOOK_SECRET: Type.String({ minLength: 16 }),
  /** Tempo até o resultado (RN-ONB-021): `2000-10000` ms por padrão. */
  KYC_RESULT_DELAY_MS: Type.String({ pattern: '^\\d+(-\\d+)?$', default: '2000-10000' }),
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

const { service, provider, dispatcher } = createKycSimulator({
  config,
  db,
  clock,
  logger,
  behavior: behaviorFromConfig(config),
  resultDelay: parseLatency(config.KYC_RESULT_DELAY_MS),
  newId: uuidv7,
  webhook: { url: config.WEBHOOK_URL, secret: config.WEBHOOK_SECRET },
});

provider.start();
dispatcher.start();
service.onShutdown('database', () => db.destroy());
service.onShutdown('webhooks', () => dispatcher.stop());
service.onShutdown('provider', () => provider.stop());
await service.start();
