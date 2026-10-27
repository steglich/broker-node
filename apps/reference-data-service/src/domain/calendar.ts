import type { CalendarData, DayType, ScheduledPhase, SessionScheduleData } from '@broker/calendar';
import { BusinessDate } from '@broker/domain-kernel';
import { ReferenceRuleError } from './errors.js';

/** RN-CAL-001: alerta ao backoffice faltando 60 dias para o fim do calendário carregado. */
export const COVERAGE_ALERT_DAYS = 60;

/** Uma linha de `trading_calendar`: todo dia do período carregado, com o tipo (Pregão §3.1). */
export interface CalendarDay {
  date: BusinessDate;
  dayType: DayType;
  description: string | null;
}

/** Uma vigência de `session_schedule` (RN-CAL-003). */
export interface StoredSchedule extends SessionScheduleData {
  id: string;
  name: string;
}

/** Alteração proposta pelo backoffice (Backoffice §3: manter calendário, com aprovação). */
export interface CalendarChange {
  /** Estende o período carregado até esta data (dias úteis e fins de semana calculados). */
  extendTo?: string;
  /** Tipos dos dias; `BUSINESS_DAY` desfaz um dia especial. */
  days?: {
    date: string;
    type: 'BUSINESS_DAY' | 'HOLIDAY' | 'NO_TRADING' | 'LATE_OPEN';
    description?: string;
  }[];
}

/** Dias que mudam: as linhas novas (extensão) e as alteradas, já validadas. */
export function planCalendarChange(
  current: { from: BusinessDate; to: BusinessDate },
  change: CalendarChange,
  today: BusinessDate,
): {
  rows: CalendarDay[];
  coverageTo: BusinessDate;
  affected: { from: BusinessDate; to: BusinessDate };
} {
  const rows = new Map<number, CalendarDay>();
  let coverageTo = current.to;
  if (change.extendTo !== undefined) {
    const to = BusinessDate.parse(change.extendTo);
    if (!to.isAfter(current.to))
      fail('CALENDAR_INVALID_EXTENSION', `O calendário já vai até ${current.to.toString()}.`);
    for (let d = current.to.plusDays(1); !d.isAfter(to); d = d.plusDays(1))
      rows.set(d.epochDay, plainDay(d));
    coverageTo = to;
  }
  for (const day of change.days ?? []) {
    const d = BusinessDate.parse(day.date);
    if (!d.isAfter(today))
      fail('CALENDAR_PAST_DATE', `Só dias futuros mudam: ${day.date} já passou ou é hoje.`);
    if (d.isBefore(current.from) || d.isAfter(coverageTo))
      fail('CALENDAR_OUT_OF_COVERAGE', `${day.date} está fora do período carregado.`);
    if (d.isWeekend()) fail('CALENDAR_WEEKEND', `${day.date} é fim de semana.`);
    if (day.type !== 'BUSINESS_DAY' && !day.description?.trim())
      fail('CALENDAR_DESCRIPTION_REQUIRED', `Descreva o dia especial ${day.date}.`);
    rows.set(d.epochDay, {
      date: d,
      dayType: day.type,
      description: day.type === 'BUSINESS_DAY' ? null : day.description!.trim(),
    });
  }
  if (rows.size === 0) fail('CALENDAR_EMPTY_CHANGE', 'Nada a alterar.');
  const days = [...rows.keys()].sort((a, b) => a - b);
  return {
    rows: days.map((k) => rows.get(k)!),
    coverageTo,
    affected: {
      from: BusinessDate.ofEpochDay(days[0]!),
      to: BusinessDate.ofEpochDay(days[days.length - 1]!),
    },
  };
}

/** Dia comum: útil de segunda a sexta, `WEEKEND` no sábado e domingo. */
export const plainDay = (date: BusinessDate): CalendarDay => ({
  date,
  dayType: date.isWeekend() ? 'WEEKEND' : 'BUSINESS_DAY',
  description: null,
});

const PHASE_ORDER: readonly ScheduledPhase[] = [
  'PRE_TRADING',
  'PRE_OPENING',
  'CONTINUOUS',
  'CLOSING_CALL',
  'POST_CLOSE',
  'CLOSED',
];

/**
 * Nova grade com vigência (RN-CAL-003): começa num dia futuro, depois da última do mesmo tipo de
 * dia, e fecha a vigência aberta na véspera. As fases seguem a ordem do pregão, em horário crescente.
 */
export function planSchedule(
  schedules: readonly StoredSchedule[],
  proposed: Omit<StoredSchedule, 'id' | 'validTo'>,
  today: BusinessDate,
): { close: StoredSchedule | null } {
  const from = BusinessDate.parse(proposed.validFrom);
  if (!from.isAfter(today))
    fail('SCHEDULE_PAST_DATE', 'A nova grade precisa começar num dia futuro.');
  const phases = proposed.phases.map((p) => p.phase);
  if (phases.join() !== PHASE_ORDER.join())
    fail(
      'SCHEDULE_INVALID_PHASES',
      `As fases precisam ser, nesta ordem: ${PHASE_ORDER.join(', ')}.`,
    );
  const minutes = proposed.phases.map((p) => toMinutes(p.start));
  if (minutes.some((m, i) => m === null || (i > 0 && m <= minutes[i - 1]!)))
    fail('SCHEDULE_INVALID_TIMES', 'Os horários precisam ser HH:MM válidos e crescentes.');
  const sameType = schedules.filter((s) => s.dayType === proposed.dayType);
  const latest = sameType.reduce<StoredSchedule | null>(
    (acc, s) => (acc === null || s.validFrom > acc.validFrom ? s : acc),
    null,
  );
  if (latest && proposed.validFrom <= latest.validFrom)
    fail(
      'SCHEDULE_VALIDITY_OVERLAP',
      `Já existe grade ${proposed.dayType} a partir de ${latest.validFrom}.`,
    );
  return { close: latest && latest.validTo === null ? latest : null };
}

/** Dados no formato do `@broker/calendar` (publicados em `calendar.updated`, D15). */
export function toCalendarData(
  days: readonly CalendarDay[],
  schedules: readonly StoredSchedule[],
  allDaysBusiness: boolean,
): CalendarData {
  if (days.length === 0) throw new Error('calendário vazio');
  return {
    coverage: { from: days[0]!.date.toString(), to: days[days.length - 1]!.date.toString() },
    days: days
      .filter(
        (d) => d.dayType === 'HOLIDAY' || d.dayType === 'NO_TRADING' || d.dayType === 'LATE_OPEN',
      )
      .map((d) => ({
        date: d.date.toString(),
        type: d.dayType as 'HOLIDAY' | 'NO_TRADING' | 'LATE_OPEN',
        description: d.description ?? '',
      })),
    schedules: schedules.map((s) => ({
      validFrom: s.validFrom,
      validTo: s.validTo,
      dayType: s.dayType,
      phases: s.phases.map((p) => ({ phase: p.phase, start: p.start })),
    })),
    ...(allDaysBusiness ? { allDaysBusiness: true } : {}),
  };
}

/** RN-CAL-001: dias até o último dia carregado e se o alerta de 60 dias já vale. */
export function coverageStatus(today: BusinessDate, coverageEnd: BusinessDate) {
  const daysLeft = coverageEnd.epochDay - today.epochDay;
  return { daysLeft, alert: daysLeft <= COVERAGE_ALERT_DAYS };
}

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  return h < 24 && min < 60 ? h * 60 + min : null;
}

function fail(code: string, message: string): never {
  throw new ReferenceRuleError(code, message);
}
