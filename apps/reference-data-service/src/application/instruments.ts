import { BusinessDate, Instant } from '@broker/domain-kernel';
import { ReferenceRuleError } from '../domain/errors.js';
import {
  applyAttributes,
  changeStatus,
  createInstrument,
  inferType,
  matchFor,
  oddLotBase,
  oddLotEnabled,
  oddLotSymbol,
  type AssetType,
  type Board,
  type Instrument,
  type InstrumentAttributes,
  type InstrumentStatus,
  type ShareClass,
  type TypeDefaults,
} from '../domain/instrument.js';
import { renameNotice } from '../domain/symbol-history.js';
import type { CalendarService } from './calendar.js';
import { notFound, ReferenceError, rule, type Operator, type ReferenceDeps } from './context.js';
import type { BackofficeTask, ReferenceTx } from './ports.js';

/** Estado completo publicado em `instrument.created`/`updated` (Catálogo de eventos §4). */
export function instrumentState(i: Instrument) {
  return {
    instrumentId: i.id,
    symbol: i.symbol,
    oddLotSymbol: oddLotSymbol(i),
    isin: i.isin,
    shortName: i.shortName,
    longName: i.longName,
    assetType: i.assetType,
    shareClass: i.shareClass,
    sector: i.sector,
    subsector: i.subsector,
    currency: 'BRL' as const,
    lotSize: i.lotSize,
    tickSize: i.tickSize,
    oddLotEnabled: oddLotEnabled(i),
    shortSaleEnabled: i.shortSaleEnabled,
    dayTradeEnabled: i.dayTradeEnabled,
    collateralEligible: i.collateralEligible,
    haircut: i.haircut,
    taxCategory: i.taxCategory,
    status: i.status,
    tradable: i.tradable,
    logoUrl: i.logoUrl,
    source: i.source,
    updatedAt: i.updatedAt.toString(),
  };
}

export type InstrumentView = ReturnType<typeof instrumentState> & {
  statusReason: string | null;
  createdAt: string;
};

export const view = (i: Instrument): InstrumentView => ({
  ...instrumentState(i),
  statusReason: i.statusReason,
  createdAt: i.createdAt.toString(),
});

/** Item da busca: o instrumento, o livro e o ticker do livro, e o aviso de renomeação. */
export interface SearchResult {
  instrument: InstrumentView;
  board: Board;
  tradingSymbol: string;
  notice?: string;
}

export interface CatalogEntry {
  symbol: string;
  shortName?: string | null;
  longName?: string | null;
  assetType?: AssetType;
  sector?: string | null;
  logoUrl?: string | null;
}

/** Cadastro de instrumentos, status e catálogo (Ativos §2, §3, §5; RN-INS-010/020). */
export class Instruments {
  constructor(
    private readonly d: ReferenceDeps,
    private readonly calendar: CalendarService,
  ) {}

  // ---------------------------------------------------------------- consulta

  async get(id: string): Promise<InstrumentView> {
    const i = await this.d.store.transaction((tx) => tx.instrument(id));
    if (!i) throw notFound('Instrumento inexistente.');
    return view(i);
  }

  async list(filter: {
    tradable?: boolean;
    status?: InstrumentStatus;
    limit: number;
    after?: string;
  }) {
    const items = await this.d.store.transaction((tx) => tx.instruments(filter));
    return {
      items: items.map(view),
      ...(items.length === filter.limit ? { nextCursor: items[items.length - 1]!.symbol } : {}),
    };
  }

  /**
   * Busca (RN-INS-010): o ticker exato vem primeiro, no livro certo (`PETR4F` → PETR4 no
   * `ODD_LOT`, RN-INS-002), ou pelo ticker antigo com aviso (RN-INS-032); depois os prefixos de
   * ticker e os nomes que contêm o texto.
   */
  async search(text: string, limit: number): Promise<SearchResult[]> {
    const q = text.trim().toUpperCase();
    if (q.length === 0) return [];
    return this.d.store.transaction(async (tx) => {
      const out: SearchResult[] = [];
      const seen = new Set<string>();
      const push = (r: SearchResult) => {
        const key = `${r.instrument.instrumentId}:${r.board}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(r);
      };
      const exact = await this.resolveIn(tx, q);
      if (exact) push(exact);
      for (const i of await tx.searchInstruments(q, limit)) {
        push({ instrument: view(i), board: 'MAIN', tradingSymbol: i.symbol });
        const odd = oddLotSymbol(i);
        if (odd?.startsWith(q)) push({ instrument: view(i), board: 'ODD_LOT', tradingSymbol: odd });
      }
      return out.slice(0, limit);
    });
  }

  /** Resolve um ticker exato (principal, fracionário ou antigo); `INSTRUMENT_NOT_FOUND` se não há. */
  async resolve(symbol: string): Promise<SearchResult> {
    const r = await this.d.store.transaction((tx) =>
      this.resolveIn(tx, symbol.trim().toUpperCase()),
    );
    if (!r) throw new ReferenceError(404, 'INSTRUMENT_NOT_FOUND', `Ticker inexistente: ${symbol}.`);
    return r;
  }

  private async resolveIn(tx: ReferenceTx, q: string): Promise<SearchResult | null> {
    const direct = await tx.instrumentBySymbol(q);
    if (direct) return { instrument: view(direct), board: 'MAIN', tradingSymbol: q };
    const base = oddLotBase(q);
    if (base) {
      const i = await tx.instrumentBySymbol(base);
      const m = i ? matchFor(i, q) : null;
      // RN-INS-006: com lote 1 não há fracionário; o ticker …F não resolve.
      if (i && m) return { instrument: view(i), board: m.board, tradingSymbol: m.tradingSymbol };
    }
    const [old] = await tx.historyBySymbol(q);
    if (old) {
      const i = await tx.instrument(old.instrumentId);
      if (i)
        return {
          instrument: view(i),
          board: 'MAIN',
          tradingSymbol: i.symbol,
          notice: renameNotice(q, i.symbol, old.validTo.plusDays(1)),
        };
    }
    return null;
  }

  // ---------------------------------------------------------------- backoffice (BO_MARKET, sem aprovação)

  async create(
    op: Operator,
    input: {
      symbol: string;
      assetType: AssetType;
      shareClass?: ShareClass;
      attributes?: Partial<InstrumentAttributes>;
    },
  ): Promise<InstrumentView> {
    return this.d.store.transaction(async (tx) => {
      const symbol = input.symbol.trim().toUpperCase();
      if (await tx.instrumentBySymbol(symbol))
        throw rule('SYMBOL_ALREADY_EXISTS', `Já existe instrumento com o ticker ${symbol}.`);
      const i = createInstrument(
        {
          id: this.d.newId(),
          symbol,
          assetType: input.assetType,
          ...(input.shareClass ? { shareClass: input.shareClass } : {}),
          source: 'MANUAL',
          ...(input.attributes ? { overrides: input.attributes } : {}),
        },
        await tx.typeDefaults(input.assetType),
        this.d.clock.now(),
      );
      await tx.insertInstrument(i);
      await tx.publish({ type: 'instrument.created', payload: instrumentState(i) }, i.id);
      this.d.logger.info({
        event: 'instrument.created',
        instrumentId: i.id,
        symbol,
        operator: op.id,
      });
      return view(i);
    });
  }

  async update(
    op: Operator,
    id: string,
    patch: Partial<InstrumentAttributes>,
  ): Promise<InstrumentView> {
    return this.d.store.transaction(async (tx) => {
      const i = await tx.instrument(id, { forUpdate: true });
      if (!i) throw notFound('Instrumento inexistente.');
      const next = applyAttributes(i, patch, this.d.clock.now());
      await tx.saveInstrument(next);
      await tx.publish({ type: 'instrument.updated', payload: instrumentState(next) }, i.id);
      this.d.logger.info({
        event: 'instrument.updated',
        instrumentId: id,
        fields: Object.keys(patch),
        operator: op.id,
      });
      return view(next);
    });
  }

  typeDefaults(): Promise<TypeDefaults[]> {
    return this.d.store.transaction((tx) => tx.allTypeDefaults());
  }

  /** Padrões por tipo (Ativos §2.2): valem para os próximos cadastros, não mudam os existentes. */
  async updateTypeDefaults(type: AssetType, patch: Partial<Omit<TypeDefaults, 'assetType'>>) {
    return this.d.store.transaction(async (tx) => {
      const current = await tx.typeDefaults(type);
      const next: TypeDefaults = { ...current, ...patch, assetType: type };
      // Reaproveita a validação do instrumento (lote, tick, haircut).
      applyAttributes(
        createInstrument(
          { id: 'x', symbol: 'TEST3', assetType: type, source: 'MANUAL' },
          next,
          this.d.clock.now(),
        ),
        {},
        this.d.clock.now(),
      );
      if (!next.collateralEligible) next.haircut = null;
      await tx.saveTypeDefaults(next);
      return next;
    });
  }

  /** Suspender/retomar (Backoffice §3: BO_MARKET, sem aprovação). */
  async setStatus(
    op: Operator,
    id: string,
    to: 'SUSPENDED' | 'ACTIVE' | 'DELISTED',
    reason: string,
  ) {
    return this.d.store.transaction(async (tx) => {
      const i = await tx.instrument(id, { forUpdate: true });
      if (!i) throw notFound('Instrumento inexistente.');
      if (to === 'DELISTED' && i.tradable)
        throw rule('INSTRUMENT_TRADABLE', 'Retire o instrumento do universo antes de deslistar.');
      const next = await this.transition(tx, i, to, reason);
      this.d.logger.info({ event: 'instrument.status_set', instrumentId: id, to, operator: op.id });
      return view(next);
    });
  }

  // ---------------------------------------------------------------- eventos do market-data

  /**
   * `market_data.catalog_synced` (RN-INS-010): tickers novos entram para consulta, fora do universo
   * e com `source = BRAPI`. Os que saíram da fonte são deslistados; se ainda estão no universo, o
   * backoffice decide (tarefa), porque a retirada exige aprovação.
   */
  async onCatalogSynced(
    tx: ReferenceTx,
    p: { newSymbols: CatalogEntry[]; inactiveSymbols: string[]; syncedAt: string },
  ): Promise<{ created: number; delisted: number }> {
    const now = this.d.clock.now();
    let created = 0;
    let delisted = 0;
    for (const entry of p.newSymbols) {
      if (await tx.instrumentBySymbol(entry.symbol)) continue;
      const assetType = entry.assetType ?? inferType(entry.symbol).assetType;
      const i = createInstrument(
        {
          id: this.d.newId(),
          symbol: entry.symbol,
          assetType,
          source: 'BRAPI',
          shortName: entry.shortName ?? null,
          longName: entry.longName ?? null,
          sector: entry.sector ?? null,
          logoUrl: entry.logoUrl ?? null,
        },
        await tx.typeDefaults(assetType),
        now,
      );
      await tx.insertInstrument(i);
      await tx.publish({ type: 'instrument.created', payload: instrumentState(i) }, i.id);
      created++;
    }
    for (const symbol of p.inactiveSymbols) {
      const i = await tx.instrumentBySymbol(symbol, { forUpdate: true });
      if (!i || i.status === 'DELISTED') continue;
      if (i.tradable) {
        await this.openTask(tx, {
          kind: 'TRADABLE_REMOVED_FROM_CATALOG',
          dedupeKey: `catalog:${i.id}`,
          instrumentId: i.id,
          data: { symbol, syncedAt: p.syncedAt },
          message: `${symbol} saiu do catálogo da brapi mas está no universo negociável.`,
        });
        continue;
      }
      await this.transition(tx, i, 'DELISTED', 'REMOVED_FROM_CATALOG');
      delisted++;
    }
    return { created, delisted };
  }

  /**
   * `market_data.instrument_stale` (RN-INS-020): guarda desde quando falta cotação e suspende se a
   * defasagem já passou de `max_quote_staleness` dias úteis. A rotina diária reavalia os demais.
   */
  async onInstrumentStale(tx: ReferenceTx, p: { instrumentId: string; staleSince: string }) {
    const i = await tx.instrument(p.instrumentId, { forUpdate: true });
    if (!i || i.status === 'DELISTED') return;
    const since = Instant.parse(p.staleSince);
    const next = i.staleSince && !since.isBefore(i.staleSince) ? i : { ...i, staleSince: since };
    if (next !== i) await tx.saveInstrument(next);
    await this.suspendIfStale(tx, next);
  }

  /**
   * Cotação válida recebida: o instrumento sai da defasagem; `PENDING` (aguardando a primeira
   * cotação) e a suspensão por defasagem voltam a `ACTIVE`. O consumidor da cotação do
   * market-data (grupo 17) chama este caso de uso.
   */
  async onQuoteReceived(tx: ReferenceTx, instrumentId: string): Promise<void> {
    const i = await tx.instrument(instrumentId, { forUpdate: true });
    if (!i || i.status === 'DELISTED') return;
    const next: Instrument = i.staleSince ? { ...i, staleSince: null } : i;
    if (next !== i) await tx.saveInstrument(next);
    if (next.status === 'PENDING') await this.transition(tx, next, 'ACTIVE', 'FIRST_QUOTE');
    else if (next.status === 'SUSPENDED' && next.statusReason === 'STALE_REFERENCE_PRICE')
      await this.transition(tx, next, 'ACTIVE', 'QUOTE_RESTORED');
  }

  /** Rotina diária: suspende quem passou da defasagem máxima (RN-INS-020). */
  async suspendStale(): Promise<number> {
    return this.d.store.transaction(async (tx) => {
      let n = 0;
      for (const i of await tx.staleInstruments()) {
        const locked = (await tx.instrument(i.id, { forUpdate: true }))!;
        if (await this.suspendIfStale(tx, locked)) n++;
      }
      return n;
    });
  }

  private async suspendIfStale(tx: ReferenceTx, i: Instrument): Promise<boolean> {
    if (!i.staleSince || i.status === 'SUSPENDED' || i.status === 'DELISTED') return false;
    const cal = await this.calendar.current(tx);
    const today = this.d.clock.now().businessDate();
    const days = cal.businessDaysBetween(BusinessDate.fromInstant(i.staleSince), today);
    if (days < this.d.maxQuoteStalenessDays) return false;
    await this.transition(tx, i, 'SUSPENDED', 'STALE_REFERENCE_PRICE');
    return true;
  }

  // ---------------------------------------------------------------- internos

  /** Muda o status e publica `instrument.status_changed` e o novo estado. */
  async transition(tx: ReferenceTx, i: Instrument, to: InstrumentStatus, reason: string) {
    let next: Instrument;
    try {
      next = changeStatus(i, to, reason, this.d.clock.now());
    } catch (err) {
      if (err instanceof ReferenceRuleError) throw rule(err.code, err.message);
      throw err;
    }
    if (next === i) return i;
    await tx.saveInstrument(next);
    await tx.publish(
      {
        type: 'instrument.status_changed',
        payload: { instrumentId: i.id, symbol: i.symbol, from: i.status, to, reason },
      },
      i.id,
    );
    await tx.publish({ type: 'instrument.updated', payload: instrumentState(next) }, i.id);
    return next;
  }

  /** Abre a tarefa (idempotente pela chave) e avisa o backoffice. */
  async openTask(
    tx: ReferenceTx,
    t: Pick<BackofficeTask, 'kind' | 'dedupeKey' | 'instrumentId' | 'data'> & { message: string },
  ): Promise<boolean> {
    const created = await tx.insertTask({
      id: this.d.newId(),
      kind: t.kind,
      dedupeKey: t.dedupeKey,
      instrumentId: t.instrumentId,
      data: { ...t.data, message: t.message },
      status: 'OPEN',
      createdAt: this.d.clock.now(),
      resolvedBy: null,
      resolvedAt: null,
    });
    if (created) {
      this.d.logger.warn(
        { event: 'reference.backoffice_alert', kind: t.kind, ...t.data },
        t.message,
      );
      this.d.onAlert?.({ kind: t.kind, message: t.message, data: t.data });
    }
    return created;
  }
}
