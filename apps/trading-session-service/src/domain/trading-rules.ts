/** Os parâmetros de negociação que a sessão usa (Ativos §7), já resolvidos para um instrumento. */
export interface SessionRules {
  rejectionBandPct: string;
  staticAuctionBandPct: string;
  dynamicAuctionBandPct: string;
  volatilityAuctionDurationS: number;
  /** Prorrogação quando o teórico continua fora do túnel (RN-AUC-003). */
  volatilityAuctionExtensionS: number;
  auctionRandomEndMaxS: number;
}

/** Padrão global de fábrica (Ativos §7): vale até chegar `instrument.trading_rules_changed`. */
export const DEFAULT_SESSION_RULES: SessionRules = {
  rejectionBandPct: '0.20',
  staticAuctionBandPct: '0.08',
  dynamicAuctionBandPct: '0.03',
  volatilityAuctionDurationS: 300,
  volatilityAuctionExtensionS: 120,
  auctionRandomEndMaxS: 30,
};

/** Global (vigente) mais a sobrescrita vigente do instrumento, só nos campos que ela traz. */
export function resolveRules(
  global: Partial<SessionRules> | null,
  override: Partial<SessionRules> | null,
): SessionRules {
  return { ...DEFAULT_SESSION_RULES, ...(global ?? {}), ...(override ?? {}) };
}
