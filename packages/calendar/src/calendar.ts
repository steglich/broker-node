import { BusinessDate, type Instant } from '@broker/domain-kernel';
import type {
  CalendarData,
  CalendarDayData,
  DayType,
  ScheduledPhase,
  SessionScheduleData,
} from './types.js';

export class CalendarNotLoadedError extends Error {
  override readonly name = 'CalendarNotLoadedError';
  readonly code = 'CALENDAR_NOT_LOADED';
}

export interface SessionPhaseWindow {
  phase: Exclude<ScheduledPhase, 'CLOSED'>;
  startsAt: Instant;
  endsAt: Instant;
}

interface LoadedCalendar {
  data: CalendarData;
  from: BusinessDate;
  to: BusinessDate;
  allDaysBusiness: boolean;
  special: Map<number, CalendarDayData>;
  schedules: ReadonlyArray<SessionScheduleData & { fromDay: number; toDay: number }>;
}

export interface SessionSchedule {
  date: BusinessDate;
  dayType: 'BUSINESS_DAY' | 'LATE_OPEN';
  phases: SessionPhaseWindow[];
}

/**
 * Funções de calendário que todos os serviços usam (RN-CAL-002), sobre os dados publicados pelo
 * dono do calendário. Funções puras sobre os dados carregados: a mesma entrada dá sempre a mesma
 * resposta, sem relógio. Os dados só mudam por `replace` (a cópia local, D15).
 *
 * Fora do período carregado (`coverage`) as funções falham com `CALENDAR_NOT_LOADED` em vez de
 * supor que o dia é útil (RN-CAL-001 exige o ano corrente e o seguinte carregados).
 */
export class TradingCalendar {
  private state!: LoadedCalendar;

  constructor(data: CalendarData) {
    this.replace(data);
  }

  /**
   * Troca os dados pela versão nova publicada pelo dono (`calendar.updated`, D15). Valida tudo
   * antes: com dados inválidos lança e o calendário atual continua valendo. Quem guarda a
   * instância passa a responder com os dados novos.
   */
  replace(data: CalendarData): void {
    const special = new Map<number, CalendarDayData>();
    for (const day of data.days) {
      const d = BusinessDate.parse(day.date);
      if (special.has(d.epochDay)) throw new Error(`dia repetido no calendário: ${day.date}`);
      if (d.isWeekend()) throw new Error(`dia especial num fim de semana: ${day.date}`);
      special.set(d.epochDay, day);
    }
    this.state = {
      data,
      from: BusinessDate.parse(data.coverage.from),
      to: BusinessDate.parse(data.coverage.to),
      allDaysBusiness: data.allDaysBusiness ?? false,
      special,
      schedules: data.schedules.map((s) => ({
        ...s,
        fromDay: BusinessDate.parse(s.validFrom).epochDay,
        toDay:
          s.validTo === null ? Number.MAX_SAFE_INTEGER : BusinessDate.parse(s.validTo).epochDay,
      })),
    };
  }

  /** Os dados em uso (os da semente ou os do último `calendar.updated`). */
  data(): CalendarData {
    return this.state.data;
  }

  /** Tipo do dia (§3.1). No sandbox (`allDaysBusiness`), todo dia é `BUSINESS_DAY`. */
  dayType(date: BusinessDate): DayType {
    this.assertLoaded(date);
    if (this.state.allDaysBusiness) return 'BUSINESS_DAY';
    if (date.isWeekend()) return 'WEEKEND';
    return this.state.special.get(date.epochDay)?.type ?? 'BUSINESS_DAY';
  }

  /** `is_business_day`: dia com negociação e liquidação (`BUSINESS_DAY` ou `LATE_OPEN`). */
  isBusinessDay(date: BusinessDate): boolean {
    const type = this.dayType(date);
    return type === 'BUSINESS_DAY' || type === 'LATE_OPEN';
  }

  /** `next_business_day(d, n)` → D+n: o n-ésimo dia útil depois de `d` (n ≥ 1). */
  nextBusinessDay(date: BusinessDate, n = 1): BusinessDate {
    return this.step(date, n, 1);
  }

  /** `previous_business_day(d, n)`: o n-ésimo dia útil antes de `d` (n ≥ 1). */
  previousBusinessDay(date: BusinessDate, n = 1): BusinessDate {
    return this.step(date, n, -1);
  }

  /**
   * `business_days_between(a, b)`: quantos dias úteis existem em (a, b], isto é, depois de `a`
   * até `b` inclusive. Assim `business_days_between(d, next_business_day(d, n)) = n`.
   * Se `b` vem antes de `a`, o resultado é negativo.
   */
  businessDaysBetween(a: BusinessDate, b: BusinessDate): number {
    if (b.isBefore(a)) return -this.businessDaysBetween(b, a);
    this.assertLoaded(a);
    this.assertLoaded(b);
    let count = 0;
    for (let d = a.plusDays(1); !d.isAfter(b); d = d.plusDays(1))
      if (this.isBusinessDay(d)) count++;
    return count;
  }

  /** `session_schedule(d)`: as fases do dia com horário em UTC, ou `null` se não há pregão. */
  sessionSchedule(date: BusinessDate): SessionSchedule | null {
    const dayType = this.dayType(date);
    if (dayType !== 'BUSINESS_DAY' && dayType !== 'LATE_OPEN') return null;
    const schedule = this.state.schedules.find(
      (s) => s.dayType === dayType && s.fromDay <= date.epochDay && date.epochDay <= s.toDay,
    );
    if (!schedule)
      throw new CalendarNotLoadedError(
        `sem grade horária ${dayType} vigente em ${date.toString()}`,
      );
    const phases: SessionPhaseWindow[] = [];
    for (let i = 0; i < schedule.phases.length - 1; i++) {
      const current = schedule.phases[i]!;
      if (current.phase === 'CLOSED') break;
      phases.push({
        phase: current.phase,
        startsAt: date.atLocalTime(current.start),
        endsAt: date.atLocalTime(schedule.phases[i + 1]!.start),
      });
    }
    return { date, dayType, phases };
  }

  /** Último dia carregado; o dono do calendário alerta 60 dias antes dele (RN-CAL-001). */
  coverageEnd(): BusinessDate {
    return this.state.to;
  }

  private step(date: BusinessDate, n: number, direction: 1 | -1): BusinessDate {
    if (!Number.isInteger(n) || n < 1) throw new Error(`n precisa ser inteiro ≥ 1: ${n}`);
    let d = date;
    let remaining = n;
    while (remaining > 0) {
      d = d.plusDays(direction);
      if (this.isBusinessDay(d)) remaining--;
    }
    return d;
  }

  private assertLoaded(date: BusinessDate): void {
    const { from, to } = this.state;
    if (date.isBefore(from) || date.isAfter(to)) {
      throw new CalendarNotLoadedError(
        `calendário não carregado para ${date.toString()} (carregado: ${from.toString()} a ${to.toString()})`,
      );
    }
  }
}
