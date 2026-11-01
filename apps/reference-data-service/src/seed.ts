// Semente do ambiente local (RN-ENV-031): o universo negociável inicial. Idempotente: instrumento
// que já existe não é recriado e o que já é negociável não ganha nova solicitação.
// Uso: node dist/seed.js (no contêiner do serviço, pelo `pnpm env:seed`).
//
// A inclusão segue a dupla aprovação de verdade (BO_MARKET propõe, BO_ADMIN aprova, RN-INS-012),
// com operadores de semente: a solicitação fica registrada e o `instrument.tradability_changed` sai
// pela outbox, que o relay do serviço em execução publica.
import { wire } from './wiring.js';

/**
 * Os tickers com cotação completa nas fixtures da brapi (o provedor padrão do local, RN-BRP-095).
 * ELET3 e MGLU3 também têm fixture, mas são os casos de ticker trocado e de campos nulos.
 */
export const INITIAL_UNIVERSE = ['PETR4', 'VALE3', 'ITUB4'] as const;

const maker = { id: 'seed-market', roles: ['BO_MARKET'] };
const checker = { id: 'seed-admin', roles: ['BO_ADMIN'] };

const { app, close } = await wire({ withStream: false });
try {
  for (const symbol of INITIAL_UNIVERSE) {
    let instrument = await app.store.transaction((tx) => tx.instrumentBySymbol(symbol));
    if (!instrument) {
      // Catálogo ainda não sincronizado: cadastro manual com o padrão do tipo (Ativos §2.2).
      await app.instruments.create(maker, { symbol, assetType: 'STOCK' });
      instrument = await app.store.transaction((tx) => tx.instrumentBySymbol(symbol));
    }
    if (instrument!.tradable) {
      console.log(`${symbol}: já negociável`);
      continue;
    }
    const pending = (await app.requests.list('PENDING')).find(
      (r) => r.type === 'UNIVERSE_INCLUDE' && r.targetId === instrument!.id,
    );
    const request =
      pending ??
      (await app.universe.request(maker, {
        instrumentId: instrument!.id,
        action: 'INCLUDE',
        justification: 'Semente do ambiente local: universo inicial.',
      }));
    const decided = await app.requests.approve(checker, request.id);
    console.log(`${symbol}: incluído no universo (${decided.status})`);
  }
} finally {
  await close();
}
