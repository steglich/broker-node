// scheduler-service (catálogo de serviços §21): rotinas do dia de negócio e relógio do ambiente.
import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
import { BusinessDate, Instant } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import { createDatabase } from '@broker/persistence';
import { BaseConfigProperties, createLogger, loadConfigOrExit } from '@broker/service-kit';
import Type from 'typebox';
import { createSchedulerService } from './app.js';

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
  /** Modo do relógio do ambiente (RN-CLK-002); fixo pela vida do ambiente (RN-CLK-003). */
  CLOCK_MODE: Type.Union(
    [Type.Literal('REAL'), Type.Literal('ACCELERATED'), Type.Literal('VIRTUAL')],
    {
      default: 'REAL',
    },
  ),
  /** Início do tempo virtual (ACCELERATED/VIRTUAL) na primeira subida; depois vale o gravado. */
  CLOCK_START: Type.Optional(Type.String({ format: 'date-time' })),
  /** ACCELERATED: 6.5 ≈ um pregão (6h30) em 1 hora real. */
  CLOCK_SPEED_FACTOR: Type.Number({ exclusiveMinimum: 0, default: 1 }),
  /** Primeira data do catch-up num banco novo (padrão: hoje). */
  SCHEDULER_START_DATE: Type.Optional(Type.String({ format: 'date' })),
  /** Contextos que publicam routine.completed/failed, separados por vírgula (ex.: session,clearing). */
  ROUTINE_RESULT_CONTEXTS: Type.String({ default: '' }),
  /** Liga as rotas que mudam estado (advance_to, re-disparo, resultado manual). */
  ADMIN_API_ENABLED: Type.Boolean({ default: false }),
});

const config = loadConfigOrExit(Config);
const calendar = new TradingCalendar(b3Calendar2026To2027);
let now = () => Instant.ofEpochMillis(Date.now());
const logger = createLogger({
  service: config.SERVICE_NAME,
  environment: config.ENVIRONMENT,
  version: config.SERVICE_VERSION,
  level: config.LOG_LEVEL,
  clock: { mode: config.CLOCK_MODE, now: () => now(), businessDate: () => now().businessDate() },
});
const database = {
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
};
const db = createDatabase(database);

const app = await createSchedulerService({
  config,
  db,
  database,
  logger,
  calendar,
  newId: uuidv7,
  clock: {
    mode: config.CLOCK_MODE,
    ...(config.CLOCK_START ? { start: Instant.parse(config.CLOCK_START) } : {}),
    speedFactor: config.CLOCK_SPEED_FACTOR,
  },
  ...(config.SCHEDULER_START_DATE
    ? { startDate: BusinessDate.parse(config.SCHEDULER_START_DATE) }
    : {}),
  stream: {
    host: config.STREAM_HOST,
    port: config.STREAM_PORT,
    user: config.STREAM_USER,
    password: config.STREAM_PASSWORD,
  },
  resultContexts: config.ROUTINE_RESULT_CONTEXTS.split(',')
    .map((c) => c.trim())
    .filter(Boolean),
  adminApi: config.ADMIN_API_ENABLED,
});
// Os logs passam a carimbar o tempo do ambiente (RN-CLK-004).
now = () => app.clock.now();

app.service.onShutdown('database', () => db.destroy());
app.service.onShutdown('scheduler', () => app.stop());
await app.start();
await app.service.start();
