import { Decimal, type Instant } from '@broker/domain-kernel';
import { ReferenceRuleError } from './errors.js';

/** Ativos §2.1. */
export type AssetType = 'STOCK' | 'UNIT' | 'REIT' | 'ETF' | 'BDR';
export type ShareClass = 'ON' | 'PN' | 'PNA' | 'PNB' | 'UNIT' | 'N/A';
export type TaxCategory = 'STOCK' | 'REIT' | 'ETF_EQUITY' | 'BDR';
export type InstrumentSource = 'BRAPI' | 'MANUAL';
/** Ativos §5. */
export type InstrumentStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DELISTED';
/** Livro do Motor: principal ou fracionário (RN-INS-003). */
export type Board = 'MAIN' | 'ODD_LOT';

export const ASSET_TYPES: readonly AssetType[] = ['STOCK', 'UNIT', 'REIT', 'ETF', 'BDR'];
export const SHARE_CLASSES: readonly ShareClass[] = ['ON', 'PN', 'PNA', 'PNB', 'UNIT', 'N/A'];
export const TAX_CATEGORIES: readonly TaxCategory[] = ['STOCK', 'REIT', 'ETF_EQUITY', 'BDR'];

/**
 * Ticker do mercado principal: radical de 4–6 caracteres + 1–2 dígitos (Ativos §2.1). O radical
 * começa por letra e pode ter dígito: o próprio domínio sugere B3SA3 (RN-INS-012), o que contraria
 * o "4–6 letras" da tabela; vale o ticker real da B3.
 */
const SYMBOL = /^[A-Z][A-Z0-9]{3,5}\d{1,2}$/;

export function assertSymbol(symbol: string): void {
  if (!SYMBOL.test(symbol))
    throw new ReferenceRuleError('INVALID_SYMBOL', `Ticker inválido: ${symbol}.`);
}

/**
 * Padrão de cadastro por tipo (Ativos §2.2, haircuts de Risco §6.1). O backoffice edita a tabela
 * (`instrument_type_default`); o instrumento guarda o valor efetivo, que é o que vale na regra.
 */
export interface TypeDefaults {
  assetType: AssetType;
  lotSize: number;
  tickSize: string;
  shortSaleEnabled: boolean;
  dayTradeEnabled: boolean;
  collateralEligible: boolean;
  haircut: string | null;
  taxCategory: TaxCategory;
}

export const SEED_TYPE_DEFAULTS: readonly TypeDefaults[] = [
  {
    assetType: 'STOCK',
    lotSize: 100,
    tickSize: '0.01',
    shortSaleEnabled: true,
    dayTradeEnabled: true,
    collateralEligible: true,
    haircut: '0.30',
    taxCategory: 'STOCK',
  },
  {
    assetType: 'UNIT',
    lotSize: 100,
    tickSize: '0.01',
    shortSaleEnabled: true,
    dayTradeEnabled: true,
    collateralEligible: true,
    haircut: '0.30',
    taxCategory: 'STOCK',
  },
  {
    assetType: 'REIT',
    lotSize: 1,
    tickSize: '0.01',
    shortSaleEnabled: false,
    dayTradeEnabled: true,
    collateralEligible: true,
    haircut: '0.40',
    taxCategory: 'REIT',
  },
  {
    assetType: 'ETF',
    lotSize: 1,
    tickSize: '0.01',
    shortSaleEnabled: false,
    dayTradeEnabled: true,
    collateralEligible: true,
    haircut: '0.20',
    taxCategory: 'ETF_EQUITY',
  },
  {
    assetType: 'BDR',
    lotSize: 1,
    tickSize: '0.01',
    shortSaleEnabled: false,
    dayTradeEnabled: true,
    collateralEligible: true,
    haircut: '0.50',
    taxCategory: 'BDR',
  },
];

export interface Instrument {
  id: string;
  symbol: string;
  isin: string | null;
  shortName: string | null;
  longName: string | null;
  assetType: AssetType;
  shareClass: ShareClass;
  sector: string | null;
  subsector: string | null;
  lotSize: number;
  tickSize: string;
  shortSaleEnabled: boolean;
  dayTradeEnabled: boolean;
  collateralEligible: boolean;
  haircut: string | null;
  taxCategory: TaxCategory;
  status: InstrumentStatus;
  /** Motivo do status atual (ex.: `STALE_REFERENCE_PRICE`). */
  statusReason: string | null;
  tradable: boolean;
  logoUrl: string | null;
  source: InstrumentSource;
  /** Última cotação válida antes da defasagem informada pelo market-data (RN-INS-020). */
  staleSince: Instant | null;
  createdAt: Instant;
  updatedAt: Instant;
}

/** RN-INS-002/006: fracionário só com `lot_size > 1`. */
export const oddLotEnabled = (i: Pick<Instrument, 'lotSize'>) => i.lotSize > 1;

/** Ticker do fracionário, derivado: `symbol + "F"` (Ativos §2.1). */
export const oddLotSymbol = (i: Pick<Instrument, 'symbol' | 'lotSize'>) =>
  oddLotEnabled(i) ? `${i.symbol}F` : null;

/**
 * Tipo e classe pelo sufixo do ticker, quando a fonte não informa: 3 = ON, 4 = PN, 5 = PNA,
 * 6 = PNB, 11 = unit, 32–35 e 39 = BDR. O backoffice corrige ETFs e FIIs (também terminam em 11).
 */
export function inferType(symbol: string): { assetType: AssetType; shareClass: ShareClass } {
  const suffix = Number(/\d+$/.exec(symbol)![0]);
  if ([32, 33, 34, 35, 39].includes(suffix)) return { assetType: 'BDR', shareClass: 'N/A' };
  if (suffix === 11) return { assetType: 'UNIT', shareClass: 'UNIT' };
  const cls: Record<number, ShareClass> = { 3: 'ON', 4: 'PN', 5: 'PNA', 6: 'PNB' };
  return { assetType: 'STOCK', shareClass: cls[suffix] ?? 'N/A' };
}

export interface NewInstrument {
  id: string;
  symbol: string;
  assetType: AssetType;
  shareClass?: ShareClass;
  source: InstrumentSource;
  isin?: string | null;
  shortName?: string | null;
  longName?: string | null;
  sector?: string | null;
  subsector?: string | null;
  logoUrl?: string | null;
  /** Sobrescritas do padrão do tipo (Ativos §2.2: o backoffice altera por instrumento). */
  overrides?: Partial<InstrumentAttributes>;
}

/** Atributos que o backoffice edita no instrumento. */
export interface InstrumentAttributes {
  lotSize: number;
  tickSize: string;
  shortSaleEnabled: boolean;
  dayTradeEnabled: boolean;
  collateralEligible: boolean;
  haircut: string | null;
  taxCategory: TaxCategory;
  shareClass: ShareClass;
  isin: string | null;
  shortName: string | null;
  longName: string | null;
  sector: string | null;
  subsector: string | null;
  logoUrl: string | null;
}

/**
 * Novo instrumento com o padrão do tipo e as sobrescritas: nasce `PENDING` (aguardando a primeira
 * cotação) e fora do universo negociável (RN-INS-010/011).
 */
export function createInstrument(input: NewInstrument, defaults: TypeDefaults, now: Instant) {
  assertSymbol(input.symbol);
  const base: Instrument = {
    id: input.id,
    symbol: input.symbol,
    isin: input.isin ?? null,
    shortName: input.shortName ?? null,
    longName: input.longName ?? null,
    assetType: input.assetType,
    shareClass: input.shareClass ?? inferType(input.symbol).shareClass,
    sector: input.sector ?? null,
    subsector: input.subsector ?? null,
    lotSize: defaults.lotSize,
    tickSize: defaults.tickSize,
    shortSaleEnabled: defaults.shortSaleEnabled,
    dayTradeEnabled: defaults.dayTradeEnabled,
    collateralEligible: defaults.collateralEligible,
    haircut: defaults.collateralEligible ? defaults.haircut : null,
    taxCategory: defaults.taxCategory,
    status: 'PENDING',
    statusReason: 'AWAITING_FIRST_QUOTE',
    tradable: false,
    logoUrl: input.logoUrl ?? null,
    source: input.source,
    staleSince: null,
    createdAt: now,
    updatedAt: now,
  };
  return input.overrides ? applyAttributes(base, input.overrides, now) : base;
}

/** Aplica a edição do backoffice validando lote, tick e haircut. */
export function applyAttributes(
  i: Instrument,
  patch: Partial<InstrumentAttributes>,
  now: Instant,
): Instrument {
  const next: Instrument = { ...i, ...patch, updatedAt: now };
  if (!Number.isInteger(next.lotSize) || next.lotSize < 1)
    throw new ReferenceRuleError('INVALID_LOT_SIZE', 'O lote padrão precisa ser inteiro > 0.');
  if (i.tradable && next.lotSize !== i.lotSize)
    // Mudar o lote com livros abertos quebraria RN-INS-001/002 no meio do pregão.
    throw new ReferenceRuleError(
      'LOT_SIZE_LOCKED_WHILE_TRADABLE',
      'Retire o instrumento do universo negociável antes de mudar o lote.',
    );
  if (!isPositiveDecimal(next.tickSize))
    throw new ReferenceRuleError('INVALID_TICK_SIZE', 'O tick precisa ser um decimal > 0.');
  if (!next.collateralEligible) next.haircut = null;
  else if (next.haircut === null || !isFraction(next.haircut))
    throw new ReferenceRuleError(
      'INVALID_HAIRCUT',
      'Instrumento elegível a garantia precisa de haircut entre 0 e 1.',
    );
  return next;
}

/** Ativos §5: transições permitidas. `DELISTED` é final. */
const TRANSITIONS: Record<InstrumentStatus, readonly InstrumentStatus[]> = {
  PENDING: ['ACTIVE', 'SUSPENDED', 'DELISTED'],
  ACTIVE: ['PENDING', 'SUSPENDED', 'DELISTED'],
  SUSPENDED: ['PENDING', 'ACTIVE', 'DELISTED'],
  DELISTED: [],
};

export function changeStatus(
  i: Instrument,
  to: InstrumentStatus,
  reason: string,
  now: Instant,
): Instrument {
  if (i.status === to) return i;
  if (!TRANSITIONS[i.status].includes(to))
    throw new ReferenceRuleError(
      'INVALID_STATUS_TRANSITION',
      `O instrumento ${i.symbol} está ${i.status} e não pode ir a ${to}.`,
    );
  return { ...i, status: to, statusReason: reason, updatedAt: now };
}

/** Resultado da busca de um ticker: principal, fracionário ou ticker antigo (RN-INS-032). */
export interface SymbolMatch {
  board: Board;
  /** Ticker com que se negocia no livro (`PETR4` ou `PETR4F`). */
  tradingSymbol: string;
}

/**
 * Interpreta o ticker digitado. `PETR4F` é o fracionário de PETR4 (RN-INS-002); com lote 1 não
 * há fracionário (RN-INS-006) e o ticker não resolve.
 */
export function oddLotBase(symbol: string): string | null {
  return /^[A-Z][A-Z0-9]{3,5}\d{1,2}F$/.test(symbol) ? symbol.slice(0, -1) : null;
}

export function matchFor(i: Instrument, typed: string): SymbolMatch | null {
  if (typed === i.symbol) return { board: 'MAIN', tradingSymbol: i.symbol };
  if (typed === oddLotSymbol(i)) return { board: 'ODD_LOT', tradingSymbol: typed };
  return null;
}

const isPositiveDecimal = (v: string) => {
  try {
    return new Decimal(v).gt(0);
  } catch {
    return false;
  }
};
const isFraction = (v: string) => {
  try {
    const d = new Decimal(v);
    return d.gte(0) && d.lte(1);
  } catch {
    return false;
  }
};
