import { BusinessDate, Decimal, Instant } from '@broker/domain-kernel';

/** Níveis de degradação do orçamento (Brapi §5.3). */
export type BudgetLevel = 'NORMAL' | 'SAVING' | 'CRITICAL' | 'EXHAUSTED';

/** Janela de contagem do E9 (`usageWindow`); sem leitura, 30 dias móveis (RN-BRP-030). */
export interface UsageWindow {
  type: 'BILLING_CYCLE' | 'ROLLING_30D';
  start: Instant;
  end: Instant;
}

/** Leitura do endpoint de uso (E9), já normalizada. */
export interface ProviderUsage {
  planName: string | null;
  planLimit: number;
  currentUsage: number;
  remaining: number;
  window: UsageWindow;
}

/** Limites do plano e da política de orçamento, todos em configuração (RN-BRP-010). */
export interface BudgetPolicy {
  /** `brapi.plan.monthly_requests` (padrão 15.000): vale até a primeira leitura do E9. */
  monthlyRequests: number;
  /** `brapi.budget.safety_reserve_pct` (padrão 0,20). */
  safetyReservePct: string;
  /** Fração do disponível gasta em dias úteis (padrão 0,95). */
  businessDayFraction: string;
  /** `CRITICAL` quando restam ≤ esta fração da cota (padrão 0,05). */
  criticalPct: string;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  monthlyRequests: 15_000,
  safetyReservePct: '0.20',
  businessDayFraction: '0.95',
  criticalPct: '0.05',
};

const DAY_MS = 86_400_000;

/** Janela assumida enquanto não há leitura do E9: 30 dias móveis terminando hoje + 30. */
export function assumedWindow(now: Instant): UsageWindow {
  return { type: 'ROLLING_30D', start: now, end: now.plusMillis(30 * DAY_MS) };
}

export interface BudgetInput {
  now: Instant;
  policy: BudgetPolicy;
  /** Última leitura do E9 (ou a assumida pelo contador local). */
  usage: ProviderUsage;
  /** Requisições enviadas desde a leitura do E9 (RN-BRP-032: o E9 pode estar atrasado). */
  sentSinceUsage: number;
  /** `429` por cota recebido e ainda não desmentido por uma leitura do E9. */
  quotaExhausted: boolean;
  /** Dias úteis em `(a, b]` (o `business_days_between` do calendário). */
  businessDaysBetween: (a: BusinessDate, b: BusinessDate) => number;
}

export interface BudgetAssessment {
  level: BudgetLevel;
  /** Restante efetivo: o do E9 menos o enviado depois dele. */
  remaining: number;
  reserve: number;
  available: number;
  /** RN-BRP-031: orçamento de um dia útil e de um dia não útil. */
  businessDayBudget: number;
  nonBusinessDayBudget: number;
  /** Data projetada de esgotamento pelo ritmo médio da janela (`null` sem consumo). */
  projectedExhaustion: Instant | null;
}

/**
 * Orçamento diário e nível (RN-BRP-031, Brapi §5.3):
 * ```
 * reserva_proporcional = reserva% × planLimit × dias_corridos_restantes / dias_da_janela
 * disponível          = restante − reserva_proporcional
 * dia útil            = disponível × fração_útil / dias_úteis_restantes
 * dia não útil        = disponível × (1 − fração_útil) / (dias_corridos − dias_úteis)
 * ```
 * Nível: `EXHAUSTED` com `429` por cota ou restante 0; `CRITICAL` com ≤ 5% da cota; `SAVING`
 * quando o ritmo médio da janela esgota a cota antes do fim dela; senão `NORMAL`.
 */
export function assessBudget(input: BudgetInput): BudgetAssessment {
  const { now, policy, usage } = input;
  const remaining = Math.max(0, usage.remaining - input.sentSinceUsage);
  const today = now.businessDate();
  const endDate = usage.window.end.businessDate();
  const windowDays = Math.max(
    1,
    Math.ceil((usage.window.end.epochMillis - usage.window.start.epochMillis) / DAY_MS),
  );
  // Dias restantes contando hoje: (ontem, fim].
  const calendarDays = Math.max(1, endDate.epochDay - today.epochDay + 1);
  const businessDays = Math.max(0, input.businessDaysBetween(today.plusDays(-1), endDate));
  const reserve = new Decimal(policy.safetyReservePct)
    .times(usage.planLimit)
    .times(Math.min(calendarDays, windowDays))
    .div(windowDays)
    .floor()
    .toNumber();
  const available = Math.max(0, remaining - reserve);
  const fraction = new Decimal(policy.businessDayFraction);
  const businessDayBudget =
    businessDays > 0 ? fraction.times(available).div(businessDays).floor().toNumber() : 0;
  const nonBusiness = calendarDays - businessDays;
  const nonBusinessDayBudget =
    nonBusiness > 0
      ? new Decimal(1).minus(fraction).times(available).div(nonBusiness).floor().toNumber()
      : 0;

  const used = usage.planLimit - remaining;
  const elapsedDays = Math.max(1, (now.epochMillis - usage.window.start.epochMillis) / DAY_MS);
  const perDay = used / elapsedDays;
  const projectedExhaustion =
    perDay > 0 ? now.plusMillis(Math.floor((remaining / perDay) * DAY_MS)) : null;

  let level: BudgetLevel = 'NORMAL';
  if (input.quotaExhausted || remaining <= 0) level = 'EXHAUSTED';
  else if (new Decimal(remaining).lte(new Decimal(policy.criticalPct).times(usage.planLimit)))
    level = 'CRITICAL';
  else if (projectedExhaustion && projectedExhaustion.isBefore(usage.window.end)) level = 'SAVING';

  return {
    level,
    remaining,
    reserve,
    available,
    businessDayBudget,
    nonBusinessDayBudget,
    projectedExhaustion,
  };
}

/** Tipos de requisição, para as regras de cada nível (Brapi §5.3). */
export type RequestKind =
  | 'QUOTE'
  | 'INDEX_QUOTE'
  | 'ON_DEMAND_QUOTE'
  | 'HISTORY'
  | 'CATALOG'
  | 'RESOLVE'
  | 'USAGE'
  | 'SCHEMA_CHECK';

/**
 * Prioridades da fila (RN-BRP-042): P0 cotação com posição/ordem no pregão, P1 resto do universo,
 * P2 Ibovespa, P3 sob demanda, P4 histórico/proventos/perfil, P5 catálogo/resolve/uso/health.
 */
export type Priority = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * O nível permite enviar? (Brapi §5.3)
 * - `SAVING`: sob demanda e histórico só do cache;
 * - `CRITICAL`: só instrumentos com posição ou ordem aberta (P0) e o uso; Ibovespa desligado;
 * - `EXHAUSTED`: nada, exceto o E9 (o chamador limita a 1 a cada 6 h).
 */
export function levelAllows(level: BudgetLevel, kind: RequestKind, priority: Priority): boolean {
  if (kind === 'USAGE') return true;
  switch (level) {
    case 'NORMAL':
      return true;
    case 'SAVING':
      return kind !== 'ON_DEMAND_QUOTE' && kind !== 'HISTORY';
    case 'CRITICAL':
      return kind === 'QUOTE' && priority === 0;
    case 'EXHAUSTED':
      return false;
  }
}

/** Intervalo mínimo das leituras do universo no nível (60 min em `SAVING`/`CRITICAL`). */
export function universeIntervalMs(level: BudgetLevel, updateIntervalMs: number): number {
  return level === 'SAVING' || level === 'CRITICAL'
    ? Math.max(updateIntervalMs, 3_600_000)
    : updateIntervalMs;
}

/**
 * RN-BRP-033: teto do universo pelo orçamento:
 * `floor(orçamento_mensal × 0,45 / (leituras_por_dia × pregões_no_mês))`.
 */
export function maxUniverseSize(
  monthlyRequests: number,
  readsPerDay: number,
  tradingDaysPerMonth: number,
): number {
  return Math.floor((monthlyRequests * 0.45) / (readsPerDay * tradingDaysPerMonth));
}
