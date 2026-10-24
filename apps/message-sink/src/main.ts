// Caixa de SMS e push simulada (Sistemas simulados §4). E-mail vai por SMTP para o Mailpit.
import { RealClock } from '@broker/clock';
import { uuidv7 } from '@broker/ids';
import { createDatabase } from '@broker/persistence';
import { BaseConfigProperties, createLogger, loadConfigOrExit } from '@broker/service-kit';
import { behaviorFromConfig, SimulatorConfigProperties } from '@broker/simulator-kit';
import Type from 'typebox';
import { createMessageSink } from './app.js';

const Config = Type.Object({
  ...BaseConfigProperties,
  ...SimulatorConfigProperties,
  DB_HOST: Type.String(),
  DB_PORT: Type.Integer({ default: 5432 }),
  DB_NAME: Type.String(),
  DB_USER: Type.String(),
  DB_PASSWORD: Type.String(),
  MAILBOX_URL: Type.String({ default: 'https://mail.broker.localhost' }),
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

const { service } = createMessageSink({
  config,
  db,
  clock,
  logger,
  behavior: behaviorFromConfig(config),
  newId: uuidv7,
  mailboxUrl: config.MAILBOX_URL,
});
service.onShutdown('database', () => db.destroy());
await service.start();
