/** Parâmetros `smm_*` do FMS, já resolvidos para um instrumento (Motor §6.3, §6.4). */
export interface SmmParams {
  /** Spread total. O dono é o reference-data: chega por `instrument.trading_rules_changed` (Ativos §7). */
  spreadBps: number;
  levels: number;
  levelStepBps: number;
  baseQuantityLots: number;
  levelMultiplier: string;
  inventoryLimitLots: number;
  skewFactor: string;
  maxSweepLots: number;
  oddLotEnabled: boolean;
  requoteThresholdTicks: number;
  refreshIntervalS: number;
}

/** Padrões de fábrica (Motor §6.3 e RN-SMM-010): valem até haver vigência própria. */
export const DEFAULT_SMM_PARAMS: SmmParams = {
  spreadBps: 10,
  levels: 5,
  levelStepBps: 5,
  baseQuantityLots: 10,
  levelMultiplier: '1.5',
  inventoryLimitLots: 2000,
  skewFactor: '0.5',
  maxSweepLots: 50,
  oddLotEnabled: true,
  requoteThresholdTicks: 1,
  refreshIntervalS: 60,
};

/** Cada vigência traz só os campos que muda: a mais recente de cada campo vence, e o instrumento vence o global. */
export function resolveParams(
  global: readonly Partial<SmmParams>[],
  override: readonly Partial<SmmParams>[],
): SmmParams {
  return Object.assign({}, DEFAULT_SMM_PARAMS, ...global, ...override) as SmmParams;
}
