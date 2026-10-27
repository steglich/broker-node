import type { MarketDataTx } from './ports.js';

/**
 * Cópia local dos instrumentos (`instrument.*` do reference-data-service): ticker, tick, universo e
 * status. É ela que diz o que ler (o universo), a qual `instrument_id` uma cotação pertence e onde
 * o preço de referência existe. A carga do histórico de quem entra no universo é feita pelo laço
 * do líder (instrumento negociável sem `history_fetch`), fora da transação do consumidor.
 */
export class InstrumentReplica {
  async onState(
    tx: MarketDataTx,
    p: {
      instrumentId: string;
      symbol: string;
      tickSize: string;
      tradable: boolean;
      status: string;
    },
  ): Promise<void> {
    await tx.upsertInstrument({
      instrumentId: p.instrumentId,
      symbol: p.symbol,
      tickSize: p.tickSize,
      tradable: p.tradable,
      status: p.status as 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DELISTED',
    });
  }

  async onTradability(tx: MarketDataTx, p: { instrumentId: string; tradable: boolean }) {
    const i = await tx.instrument(p.instrumentId);
    if (i) await tx.upsertInstrument({ ...i, tradable: p.tradable });
  }

  async onSymbolChanged(tx: MarketDataTx, p: { instrumentId: string; newSymbol: string }) {
    const i = await tx.instrument(p.instrumentId);
    if (i) await tx.upsertInstrument({ ...i, symbol: p.newSymbol });
  }

  async onStatusChanged(tx: MarketDataTx, p: { instrumentId: string; to: string }) {
    const i = await tx.instrument(p.instrumentId);
    if (i) await tx.upsertInstrument({ ...i, status: p.to as typeof i.status });
  }
}
