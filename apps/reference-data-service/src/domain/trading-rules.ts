import { Decimal, type Instant } from '@broker/domain-kernel';
import { ReferenceRuleError } from './errors.js';

/** Parâmetros de negociação (Ativos §7); percentuais como fração decimal (0.20 = 20%). */
export interface TradingRulesValues {
  rejectionBandPct: string;
  staticAuctionBandPct: string;
  dynamicAuctionBandPct: string;
  volatilityAuctionDurationS: number;
  /** Prorrogação do leilão se o teórico continuar fora do túnel (RN-AUC-003). */
  volatilityAuctionExtensionS: number;
  auctionRandomEndMaxS: number;
  maxOrderQuantity: number;
  maxOrderNotional: string;
  /** RN-ORD-001. */
  marketProtectionPct: string;
  smmSpreadBps: number;
}

export const DEFAULT_TRADING_RULES: TradingRulesValues = {
  rejectionBandPct: '0.20',
  staticAuctionBandPct: '0.08',
  dynamicAuctionBandPct: '0.03',
  volatilityAuctionDurationS: 300,
  volatilityAuctionExtensionS: 120,
  auctionRandomEndMaxS: 30,
  maxOrderQuantity: 1_000_000,
  maxOrderNotional: '5000000.00',
  marketProtectionPct: '0.02',
  smmSpreadBps: 10,
};

export const RULE_FIELDS = Object.keys(DEFAULT_TRADING_RULES) as (keyof TradingRulesValues)[];

/**
 * Uma vigência de `instrument_trading_rules`: global (`instrumentId = null`, todos os campos) ou
 * sobrescrita por instrumento (só os campos sobrescritos). `validTo` é exclusivo.
 */
export interface TradingRuleVersion {
  id: string;
  instrumentId: string | null;
  values: Partial<TradingRulesValues>;
  validFrom: Instant;
  validTo: Instant | null;
  approvalRequestId: string;
}

const PCT_FIELDS = [
  'rejectionBandPct',
  'staticAuctionBandPct',
  'dynamicAuctionBandPct',
  'marketProtectionPct',
] as const;
const INT_FIELDS = [
  'volatilityAuctionDurationS',
  'volatilityAuctionExtensionS',
  'auctionRandomEndMaxS',
  'maxOrderQuantity',
  'smmSpreadBps',
] as const;

/** Valida a proposta: global com todos os campos; túneis coerentes (rejeição ≥ estático ≥ dinâmico). */
export function validateRules(
  values: Partial<TradingRulesValues>,
  scope: 'GLOBAL' | 'INSTRUMENT',
  global: TradingRulesValues,
): void {
  const unknown = Object.keys(values).filter((k) => !RULE_FIELDS.includes(k as never));
  if (unknown.length) fail(`Campos desconhecidos: ${unknown.join(', ')}.`);
  if (scope === 'GLOBAL') {
    const missing = RULE_FIELDS.filter((k) => values[k] === undefined);
    if (missing.length)
      fail(`O padrão global precisa de todos os campos: faltam ${missing.join(', ')}.`);
  } else if (Object.keys(values).length === 0) fail('A sobrescrita precisa de ao menos um campo.');
  for (const k of PCT_FIELDS) {
    const v = values[k];
    if (v !== undefined && !(decimal(v)?.gt(0) && decimal(v)!.lt(1)))
      fail(`${k} precisa ser uma fração entre 0 e 1 (exclusivos).`);
  }
  for (const k of INT_FIELDS) {
    const v = values[k];
    if (
      v !== undefined &&
      (!Number.isInteger(v) ||
        v < (k === 'volatilityAuctionExtensionS' || k === 'auctionRandomEndMaxS' ? 0 : 1))
    )
      fail(`${k} precisa ser inteiro válido.`);
  }
  if (values.maxOrderNotional !== undefined && !decimal(values.maxOrderNotional)?.gt(0))
    fail('maxOrderNotional precisa ser > 0.');
  const merged = { ...global, ...values };
  const [rej, sta, dyn] = [
    merged.rejectionBandPct,
    merged.staticAuctionBandPct,
    merged.dynamicAuctionBandPct,
  ].map((v) => new Decimal(v));
  if (rej!.lt(sta!) || sta!.lt(dyn!))
    fail('Os túneis precisam respeitar rejeição ≥ leilão estático ≥ leilão dinâmico.');
}

/** A vigência ativa no instante: `validFrom ≤ at < validTo`. */
export function activeAt(versions: readonly TradingRuleVersion[], at: Instant) {
  return (
    versions.find(
      (v) => !v.validFrom.isAfter(at) && (v.validTo === null || at.isBefore(v.validTo)),
    ) ?? null
  );
}

export interface EffectiveRules {
  values: TradingRulesValues;
  globalRuleId: string | null;
  overrideRuleId: string | null;
  /** Campos que vêm da sobrescrita do instrumento. */
  overridden: (keyof TradingRulesValues)[];
}

/** Regras vigentes: padrão global vigente + sobrescrita vigente do instrumento (Ativos §7). */
export function effectiveRules(
  global: readonly TradingRuleVersion[],
  override: readonly TradingRuleVersion[],
  at: Instant,
): EffectiveRules {
  const g = activeAt(global, at);
  const o = activeAt(override, at);
  return {
    values: { ...DEFAULT_TRADING_RULES, ...g?.values, ...o?.values },
    globalRuleId: g?.id ?? null,
    overrideRuleId: o?.id ?? null,
    overridden: o ? (Object.keys(o.values) as (keyof TradingRulesValues)[]) : [],
  };
}

/**
 * Nova vigência no escopo (global ou um instrumento): começa depois da última e fecha a vigência
 * aberta em `validFrom`, sem sobreposição. Hoje continua valendo a anterior até lá.
 */
export function planNewVersion(
  versions: readonly TradingRuleVersion[],
  validFrom: Instant,
  now: Instant,
): { close: TradingRuleVersion | null } {
  if (validFrom.isBefore(now))
    throw new ReferenceRuleError('VALID_FROM_IN_PAST', 'A vigência não pode começar no passado.');
  const latest = versions.reduce<TradingRuleVersion | null>(
    (acc, v) => (acc === null || v.validFrom.isAfter(acc.validFrom) ? v : acc),
    null,
  );
  if (latest && !validFrom.isAfter(latest.validFrom))
    throw new ReferenceRuleError(
      'RULES_VALIDITY_OVERLAP',
      `Já existe vigência a partir de ${latest.validFrom.toString()} neste escopo.`,
    );
  return { close: latest && latest.validTo === null ? latest : null };
}

function fail(message: string): never {
  throw new ReferenceRuleError('INVALID_TRADING_RULES', message);
}

function decimal(v: string): Decimal | null {
  try {
    return new Decimal(v);
  } catch {
    return null;
  }
}
