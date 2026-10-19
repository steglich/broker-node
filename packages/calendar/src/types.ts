/** Tipos de dia (Pregão e calendário §3.1). Fim de semana é calculado, não cadastrado. */
export type DayType = 'BUSINESS_DAY' | 'HOLIDAY' | 'NO_TRADING' | 'LATE_OPEN' | 'WEEKEND';

/** Fases com horário fixo na grade (§4.1). Leilão por volatilidade e suspensão são dinâmicos. */
export type ScheduledPhase =
  'PRE_TRADING' | 'PRE_OPENING' | 'CONTINUOUS' | 'CLOSING_CALL' | 'POST_CLOSE' | 'CLOSED';

/** Dia especial cadastrado (`trading_calendar`, RN-CAL-001). Dias úteis comuns não são listados. */
export interface CalendarDayData {
  date: string;
  type: Exclude<DayType, 'BUSINESS_DAY' | 'WEEKEND'>;
  description: string;
}

/**
 * Grade horária com vigência (RN-CAL-003). Cada fase começa no horário indicado (BRT) e vai até
 * a próxima; a última entrada (`CLOSED`) marca o fim do dia de pregão.
 */
export interface SessionScheduleData {
  validFrom: string;
  /** Inclusivo; `null` = sem fim. */
  validTo: string | null;
  dayType: 'BUSINESS_DAY' | 'LATE_OPEN';
  phases: ReadonlyArray<{ phase: ScheduledPhase; start: string }>;
}

/** Dados do calendário, como publicados pelo dono (`calendar.updated`, D15). */
export interface CalendarData {
  /** Período carregado (inclusivo). Fora dele as funções recusam responder. */
  coverage: { from: string; to: string };
  days: readonly CalendarDayData[];
  schedules: readonly SessionScheduleData[];
}
