import type { Clock } from '@broker/clock';
import { createService, type BaseConfig, type Logger } from '@broker/service-kit';
import { registerControlRoutes, SimulatorControl, type Behavior } from '@broker/simulator-kit';
import { WebhookDispatcher } from '@broker/webhooks';
import { sql, type Kysely } from 'kysely';
import { registerApi } from './api.js';
import { PIX_SCENARIOS, PixBank, type BankOptions, type PixScenario } from './bank.js';
import { registerUi } from './ui.js';

export interface PixSimulatorDeps {
  config: BaseConfig;
  db: Kysely<unknown>;
  clock: Clock;
  logger: Logger;
  behavior: Behavior;
  newId: () => string;
  webhook: { url: string; secret: string; retryScheduleMs?: readonly number[] };
  bank: Pick<BankOptions, 'defaultInitialBalance' | 'broker'>;
  /** Aleatoriedade das falhas simuladas; PRNG semeado nos testes. */
  random?: () => number;
}

/**
 * Monta o simulador. A ordem importa: UI e controle primeiro (nunca falham), depois o middleware
 * de comportamento (RN-SIM-002) e só então a API, que é o que o núcleo chama.
 */
export function createPixSimulator(deps: PixSimulatorDeps) {
  const control = new SimulatorControl<PixScenario>(deps.behavior, deps.clock, deps.random);
  const dispatcher = new WebhookDispatcher({
    db: deps.db,
    secret: deps.webhook.secret,
    clock: deps.clock,
    newId: deps.newId,
    ...(deps.webhook.retryScheduleMs ? { retryScheduleMs: deps.webhook.retryScheduleMs } : {}),
    onError: (err) =>
      deps.logger.error({ event: 'webhook.dispatch_failed', err }, 'falha no despachante'),
  });
  const bank = new PixBank({
    db: deps.db,
    clock: deps.clock,
    dispatcher,
    control,
    newId: deps.newId,
    webhookUrl: deps.webhook.url,
    ...deps.bank,
  });
  const service = createService({
    config: deps.config,
    clock: deps.clock,
    logger: deps.logger,
    readiness: { database: () => sql`SELECT 1`.execute(deps.db) },
  });
  registerControlRoutes(service, control, PIX_SCENARIOS);
  registerUi(service, bank, control, dispatcher);
  service.use(control.middleware());
  registerApi(service, bank);
  return { service, bank, control, dispatcher };
}
