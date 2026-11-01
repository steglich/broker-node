import {
  CreateHoldBody,
  PreTradeBody,
  ReleaseHoldBody,
  riskServiceHttp,
} from '@broker/contracts/http/risk-service';
import { serviceUnavailable, type HandlerResult, type Service } from '@broker/service-kit';
import { RiskUnavailableError } from '../application/context.js';
import type { Decisions } from '../application/decisions.js';

const r = riskServiceHttp.routes;

export interface HttpDeps {
  decisions: Decisions;
}

export function registerHttp(service: Service, d: HttpDeps): void {
  /** Sem projeção pronta, `503 RISK_UNAVAILABLE`: quem chama recusa a operação (RN-RSK-002). */
  const run = async (fn: () => Promise<HandlerResult>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RiskUnavailableError)
        throw serviceUnavailable('RISK_UNAVAILABLE', err.message);
      throw err;
    }
  };

  service.route({
    method: 'post',
    path: '/v1/internal/risk/pre-trade',
    idempotent: false,
    auth: { principal: 'service', scopes: ['risk:pretrade'] },
    validate: { body: PreTradeBody },
    handler: (q) => run(async () => ({ body: await d.decisions.preTrade(q.body) })),
  });
  service.route({
    method: 'post',
    path: '/v1/internal/risk/holds',
    idempotent: false,
    auth: { principal: 'service', scopes: ['risk:holds'] },
    validate: { body: CreateHoldBody },
    handler: (q) =>
      run(async () => ({
        body: await d.decisions.createHold({
          requestId: q.body.requestId,
          accountId: q.body.accountId,
          amount: q.body.amount,
          referenceId: q.body.reference.id,
        }),
      })),
  });
  service.route({
    method: 'post',
    path: '/v1/internal/risk/holds/:id/release',
    idempotent: false,
    auth: { principal: 'service', scopes: ['risk:holds'] },
    validate: { params: r.releaseHold.params, body: ReleaseHoldBody },
    handler: (q) =>
      run(async () => ({ body: await d.decisions.releaseHold(q.params.id, q.body.outcome) })),
  });
}
