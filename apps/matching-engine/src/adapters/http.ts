import { matchingEngineHttp } from '@broker/contracts/http/matching-engine';
import { HttpError, type Service } from '@broker/service-kit';
import { replayAndCompare } from '../application/replay.js';
import type { EngineStore } from '../application/ports.js';
import type { EnginePartition } from '../application/partition.js';

const r = matchingEngineHttp.routes;
/** Backoffice §3: `BO_MARKET` opera o pregão. */
const ADMIN = { roles: ['BO_MARKET', 'BO_ADMIN'] };

export interface HttpDeps {
  store: EngineStore;
  /** As partições que esta instância lidera agora. */
  partitions: () => readonly EnginePartition[];
}

/** Sem rota de negócio de propósito (Catálogo §9): ordem só entra por `engine.commands`. */
export function registerHttp(service: Service, d: HttpDeps): void {
  const owner = (instrumentId: string) =>
    d.partitions().find((p) => p.engine(instrumentId) !== undefined);

  service.route({
    method: 'get',
    path: r.books.path,
    auth: ADMIN,
    idempotent: false,
    handler: async () => {
      const items = (await d.store.allInstruments()).map(({ instrumentId, partition }) => {
        const engine = owner(instrumentId)?.engine(instrumentId);
        return {
          instrumentId,
          partition,
          phase: engine?.phase ?? null,
          inputSeq: engine?.inputSeq ?? null,
        };
      });
      return { body: { items } };
    },
  });

  service.route({
    method: 'post',
    path: r.snapshot.path,
    auth: ADMIN,
    idempotent: false,
    validate: { params: r.snapshot.params },
    handler: async (q) => {
      const { instrumentId } = q.params;
      const inputSeq = await owner(instrumentId)?.requestSnapshot(instrumentId);
      if (inputSeq === undefined || inputSeq === null)
        throw new HttpError(404, 'BOOK_NOT_FOUND', 'Livro não está nesta instância.');
      return { body: { instrumentId, inputSeq } };
    },
  });

  service.route({
    method: 'post',
    path: r.replay.path,
    auth: ADMIN,
    idempotent: false,
    validate: { params: r.replay.params },
    handler: async (q) => ({ body: await replayAndCompare(d.store, q.params.instrumentId) }),
  });
}
