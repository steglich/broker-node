import type { TradingCalendar } from '@broker/calendar';
import type { Clock } from '@broker/clock';
import type { Logger } from '@broker/service-kit';
import type { BudgetPolicy } from '../domain/budget.js';
import type { SyntheticParams } from '../domain/reference-price.js';
import type {
  AlertKind,
  CorporateActionsPort,
  ExposurePort,
  MarketDataStore,
  MarketDataTx,
  ProviderAlert,
  ProviderCache,
  RawStorage,
} from './ports.js';
import type { MarketDataProvider } from './provider.js';

/** Limites do plano (Brapi §3.1, RN-BRP-010): tudo em configuração. */
export interface PlanSettings {
  /** `brapi.plan.update_interval` (padrão 30 min). */
  updateIntervalMs: number;
  /** `brapi.plan.max_history_range` (padrão `3mo`). */
  maxHistoryRange: string;
  /** Página do catálogo (E1, máx. 2000). */
  catalogPageSize: number;
  /** Prazo do P3 na fila (padrão 5 s), depois o cache com aviso. */
  onDemandWaitMs: number;
  /** Validade do cache de consultas sob demanda (30 min; 2 h em `SAVING`). */
  onDemandCacheMs: number;
  /** `synthetic.jump_alert_pct` (padrão 0,05). */
  jumpAlertPct: string;
  /** Leitura pós-fechamento (RN-BRP-052), `HH:MM` de São Paulo. */
  closeSnapshotAt: string;
}

export const DEFAULT_PLAN: PlanSettings = {
  updateIntervalMs: 1_800_000,
  maxHistoryRange: '3mo',
  catalogPageSize: 2000,
  onDemandWaitMs: 5000,
  onDemandCacheMs: 1_800_000,
  jumpAlertPct: '0.05',
  closeSnapshotAt: '18:00',
};

export interface MarketDataDeps {
  store: MarketDataStore;
  provider: MarketDataProvider;
  cache: ProviderCache;
  raw: RawStorage;
  clock: Clock;
  calendar: TradingCalendar;
  newId: () => string;
  logger: Logger;
  environment: string;
  plan: PlanSettings;
  budgetPolicy: BudgetPolicy;
  synthetic: SyntheticParams;
  exposure: ExposurePort;
  corporateActions: CorporateActionsPort;
  /** Uniforme em [0, 1) para a folga do agendamento (fora do domínio: não precisa de semente). */
  random: () => number;
  onAlert?: (alert: ProviderAlert) => void;
}

/** Erro de caso de uso, traduzido pelo adaptador HTTP em Problem Details. */
export class MarketDataError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Grava o alerta, avisa quem escuta e registra no log (Brapi §11). */
export async function raiseAlert(
  d: Pick<MarketDataDeps, 'clock' | 'newId' | 'logger' | 'onAlert'>,
  tx: MarketDataTx,
  kind: AlertKind,
  severity: ProviderAlert['severity'],
  message: string,
  data: Record<string, unknown> = {},
): Promise<ProviderAlert> {
  const alert: ProviderAlert = {
    id: d.newId(),
    kind,
    severity,
    message,
    data,
    createdAt: d.clock.now(),
  };
  await tx.insertAlert(alert);
  const log = severity === 'CRITICAL' ? d.logger.error : d.logger.warn;
  log.call(d.logger, { event: 'market_data.alert', kind, severity, data }, message);
  d.onAlert?.(alert);
  return alert;
}
