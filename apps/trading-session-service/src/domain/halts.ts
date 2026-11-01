/** Motivos de suspensão (Pregão §5). Circuit breaker: `CIRCUIT_BREAKER_L{n}`. */
export const HaltReason = {
  BACKOFFICE: 'BACKOFFICE',
  STALE_REFERENCE_PRICE: 'STALE_REFERENCE_PRICE',
  CORPORATE_ACTION: 'CORPORATE_ACTION',
  /** Outro motivo de `SUSPENDED` no reference-data (ex.: decisão no cadastro). */
  INSTRUMENT_SUSPENDED: 'INSTRUMENT_SUSPENDED',
  MARKET_DATA_UNAVAILABLE: 'MARKET_DATA_UNAVAILABLE',
  ENGINE_RECOVERY: 'ENGINE_RECOVERY',
} as const;

/** RN-HLT-002: a retomada é sempre por leilão, com duração padrão de 5 minutos. */
export const DEFAULT_RESUME_AUCTION_S = 5 * 60;

/** Suspensões que só terminam quando a causa acaba: o backoffice não as retoma à mão. */
export const AUTO_RESUMED_ONLY: ReadonlySet<string> = new Set([
  HaltReason.STALE_REFERENCE_PRICE,
  HaltReason.CORPORATE_ACTION,
  HaltReason.INSTRUMENT_SUSPENDED,
  HaltReason.ENGINE_RECOVERY,
]);

/** O motivo da suspensão vindo do status do instrumento (RN-INS-020, RN-INS-021). */
export function haltReasonOfStatus(reason: string): string {
  if (reason === HaltReason.STALE_REFERENCE_PRICE) return reason;
  if (reason.includes('CORPORATE')) return HaltReason.CORPORATE_ACTION;
  return HaltReason.INSTRUMENT_SUSPENDED;
}

export const STATUS_HALT_REASONS: readonly string[] = [
  HaltReason.STALE_REFERENCE_PRICE,
  HaltReason.CORPORATE_ACTION,
  HaltReason.INSTRUMENT_SUSPENDED,
];
