import { marketDataServiceHttp } from '@broker/contracts/http/market-data-service';
import { BusinessDate, DomainError } from '@broker/domain-kernel';
import {
  HttpError,
  MAX_LIMIT,
  type HandlerResult,
  type RouteDefinition,
  type Service,
} from '@broker/service-kit';
import type { TSchema } from 'typebox';
import type { BudgetController } from '../application/budget.js';
import type { Catalog } from '../application/catalog.js';
import { MarketDataError } from '../application/context.js';
import type { OnDemandQuotes } from '../application/on-demand.js';
import type { MarketDataStore } from '../application/ports.js';
import type { ProviderQueue } from '../application/queue.js';
import type { ReferencePrices } from '../application/reference-prices.js';

const r = marketDataServiceHttp.routes;

export interface HttpDeps {
  store: MarketDataStore;
  onDemand: OnDemandQuotes;
  catalog: Catalog;
  references: ReferencePrices;
  budget: BudgetController;
  queue: ProviderQueue;
  providerName: string;
  isLeader: () => boolean;
}

function toHttp(err: unknown): never {
  if (err instanceof MarketDataError)
    throw new HttpError(err.status, err.code, err.message, {
      ...(err.status === 422 ? { title: err.message } : {}),
    });
  if (err instanceof DomainError)
    throw new HttpError(422, err.code, err.message, { title: err.message });
  throw err;
}

/** Consulta: clientes, operadores e serviços. */
const ANY = { principal: 'any' as const };
/** Painel e operação do provedor (Backoffice §3). */
const MARKET = { roles: ['BO_MARKET', 'BO_ADMIN'] };
const PANEL = { roles: ['BO_MARKET', 'BO_ADMIN', 'BO_SUPPORT'] };

const ATTRIBUTION = 'Fonte: brapi.dev';

export function registerHttp(service: Service, d: HttpDeps): void {
  const run = async (fn: () => Promise<HandlerResult>) => {
    try {
      return await fn();
    } catch (err) {
      toHttp(err);
    }
  };
  const route = <
    SB extends TSchema | undefined = undefined,
    SQ extends TSchema | undefined = undefined,
    SP extends TSchema | undefined = undefined,
  >(
    def: RouteDefinition<SB, SQ, SP>,
  ) => service.route<SB, SQ, SP>({ idempotent: false, ...def });

  route({
    method: 'get',
    path: '/v1/market-data/external-quotes',
    auth: ANY,
    validate: { query: r.externalQuotes.query },
    handler: (q) =>
      run(async () => ({
        body: { items: await d.onDemand.getMany(q.query.symbols.toUpperCase().split(',')) },
      })),
  });
  route({
    method: 'get',
    path: '/v1/market-data/external-quotes/:symbol',
    auth: ANY,
    validate: { params: r.externalQuote.params },
    handler: (q) =>
      run(async () => ({ body: await d.onDemand.get(q.params.symbol.toUpperCase()) })),
  });
  route({
    method: 'get',
    path: '/v1/market-data/history/:symbol',
    auth: ANY,
    validate: { params: r.dailyHistory.params, query: r.dailyHistory.query },
    handler: (q) =>
      run(async () => {
        const symbol = q.params.symbol.toUpperCase();
        const h = await d.catalog.history(symbol);
        const from = q.query.from ? BusinessDate.parse(q.query.from) : undefined;
        const to = q.query.to ? BusinessDate.parse(q.query.to) : undefined;
        const items = h.candles
          .filter((c) => (!from || !c.date.isBefore(from)) && (!to || !c.date.isAfter(to)))
          .map((c) => ({ ...c, date: c.date.toString() }));
        return {
          body: {
            symbol,
            items,
            fetchedAt: h.fetchedAt?.toString() ?? null,
            fromCache: h.fromCache,
            attribution: ATTRIBUTION,
            ...(h.warning ? { warning: 'Fonte indisponível: exibindo o histórico gravado.' } : {}),
          },
        };
      }),
  });
  route({
    method: 'get',
    path: '/v1/market-data/reference-prices/:instrumentId',
    auth: ANY,
    validate: { params: r.referencePrice.params },
    handler: (q) => run(async () => ({ body: await d.references.view(q.params.instrumentId) })),
  });

  // ---------------------------------------------------------------- backoffice
  route({
    method: 'get',
    path: '/v1/bo/market-data/provider',
    auth: PANEL,
    handler: () =>
      run(async () => {
        const a = d.budget.assessment();
        const stale = await d.store.transaction(
          async (tx) =>
            (await tx.quotes()).filter((x) => x.stale && x.kind === 'INSTRUMENT').length,
        );
        return {
          body: {
            provider: d.providerName,
            leader: d.isLeader(),
            budget: {
              level: d.budget.level(),
              metered: d.budget.metered,
              remaining: d.budget.metered ? (a?.remaining ?? null) : null,
              reserve: d.budget.metered ? (a?.reserve ?? null) : null,
              businessDayBudget: d.budget.metered ? (a?.businessDayBudget ?? null) : null,
              nonBusinessDayBudget: d.budget.metered ? (a?.nonBusinessDayBudget ?? null) : null,
              projectedExhaustion: d.budget.metered
                ? (a?.projectedExhaustion?.toString() ?? null)
                : null,
              planLimit: a?.usage?.planLimit ?? null,
              windowEnd: a?.usage?.window.end.toString() ?? null,
              usageReadAt: a?.usageReadAt?.toString() ?? null,
            },
            circuit: d.queue.breakerState(),
            queueDepth: Object.fromEntries(
              Object.entries(d.queue.depth()).map(([p, n]) => [`P${p}`, n]),
            ),
            staleInstruments: stale,
          },
        };
      }),
  });
  route({
    method: 'get',
    path: '/v1/bo/market-data/alerts',
    auth: PANEL,
    validate: { query: r.providerAlerts.query },
    handler: (q) =>
      run(async () => {
        const limit = Math.min(Number(q.query.limit ?? 50) || 50, MAX_LIMIT);
        const items = await d.store.transaction((tx) => tx.alerts(limit));
        return { body: { items: items.map((a) => ({ ...a, createdAt: a.createdAt.toString() })) } };
      }),
  });
  route({
    method: 'post',
    path: '/v1/bo/market-data/reference-overrides',
    auth: MARKET,
    idempotent: true,
    validate: { body: r.createReferenceOverride.body },
    handler: (q, ctx) =>
      run(async () => ({
        status: 201,
        body: await d.references.override({
          instrumentId: q.body.instrumentId,
          price: q.body.price,
          minutes: q.body.durationMinutes,
          reason: q.body.reason,
          by: ctx.actor.id,
        }),
      })),
  });
  route({
    method: 'put',
    path: '/v1/bo/market-data/reference-noise/:instrumentId',
    auth: MARKET,
    validate: { params: r.setReferenceNoise.params, body: r.setReferenceNoise.body },
    handler: (q, ctx) =>
      run(async () => {
        await d.references.setNoise(q.params.instrumentId, q.body.enabled, ctx.actor.id);
        return { body: { instrumentId: q.params.instrumentId, enabled: q.body.enabled } };
      }),
  });
  route({
    method: 'post',
    path: '/v1/bo/market-data/provider/auth-block/clear',
    auth: MARKET,
    handler: () =>
      run(async () => {
        await d.budget.clearAuthBlock();
        d.queue.pump();
        return { status: 204 };
      }),
  });
}
