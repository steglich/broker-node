import type { Clock } from '@broker/clock';
import type { Logger } from '@broker/service-kit';
import type { Hold } from '../domain/holds.js';
import type { RiskMemory } from './memory.js';
import type { HoldEventPayload, OrphanHoldAlert, RiskStore, RiskTx } from './ports.js';

export interface RiskDeps {
  store: RiskStore;
  memory: RiskMemory;
  clock: Clock;
  newId: () => string;
  logger: Logger;
  onAlert?: (alert: OrphanHoldAlert) => void;
}

/** Sem projeção pronta ou sem a liderança: nada é aprovado (RN-RSK-002). */
export class RiskUnavailableError extends Error {
  override readonly name = 'RiskUnavailableError';
}

const holdPayload = (h: Hold): HoldEventPayload => ({
  holdId: h.id,
  accountId: h.accountId,
  type: h.type,
  resource: h.resource,
  amount: h.remainingAmount.toFixed(2),
  ...(h.remainingQuantity === null ? {} : { quantity: h.remainingQuantity }),
  reference: { type: h.referenceType, id: h.referenceId },
});

/** Grava o hold e publica o evento do ciclo dele, conforme o novo estado. */
export async function saveAndPublishHold(tx: RiskTx, h: Hold, created = false): Promise<void> {
  await tx.saveHold(h);
  const type = created
    ? 'risk.hold_created'
    : h.status === 'CONSUMED'
      ? 'risk.hold_consumed'
      : h.status === 'RELEASED'
        ? 'risk.hold_released'
        : 'risk.hold_adjusted';
  await tx.publish({ type, payload: holdPayload(h) }, h.accountId);
}
