import type { Clock } from '@broker/clock';
import { createService, type BaseConfig, type Logger } from '@broker/service-kit';
import {
  registerControlRoutes,
  SimulatorControl,
  type Behavior,
  type Latency,
} from '@broker/simulator-kit';
import { WebhookDispatcher } from '@broker/webhooks';
import { sql, type Kysely } from 'kysely';
import { registerApi } from './api.js';
import { KycProvider } from './provider.js';
import { KYC_SCENARIOS, type KycScenario } from './rules.js';
import { registerUi } from './ui.js';

export interface KycSimulatorDeps {
  config: BaseConfig;
  db: Kysely<unknown>;
  clock: Clock;
  logger: Logger;
  behavior: Behavior;
  resultDelay: Latency;
  newId: () => string;
  webhook: { url: string; secret: string };
  random?: () => number;
}

/** Mesma montagem do Banco Simulado: UI e controle, depois as falhas simuladas, depois a API. */
export function createKycSimulator(deps: KycSimulatorDeps) {
  const random = deps.random ?? Math.random;
  const control = new SimulatorControl<KycScenario>(deps.behavior, deps.clock, random);
  const dispatcher = new WebhookDispatcher({
    db: deps.db,
    secret: deps.webhook.secret,
    clock: deps.clock,
    newId: deps.newId,
    onError: (err) =>
      deps.logger.error({ event: 'webhook.dispatch_failed', err }, 'falha no despachante'),
  });
  const provider = new KycProvider({
    db: deps.db,
    clock: deps.clock,
    dispatcher,
    control,
    newId: deps.newId,
    webhookUrl: deps.webhook.url,
    resultDelay: deps.resultDelay,
    random,
  });
  const service = createService({
    config: deps.config,
    clock: deps.clock,
    logger: deps.logger,
    readiness: { database: () => sql`SELECT 1`.execute(deps.db) },
  });
  registerControlRoutes(service, control, KYC_SCENARIOS);
  registerUi(service, provider, control, dispatcher);
  service.use(control.middleware());
  registerApi(service, provider);
  return { service, provider, control, dispatcher };
}
