import { TradingCalendar, type CalendarData } from '@broker/calendar';
import { BusinessDate } from '@broker/domain-kernel';
import {
  coverageStatus,
  planCalendarChange,
  planSchedule,
  toCalendarData,
  type CalendarChange,
  type StoredSchedule,
} from '../domain/calendar.js';
import type { ChangeRequest } from '../domain/change-request.js';
import { requestView, type ChangeExecutor, type ChangeRequests } from './change-requests.js';
import type { Operator, ReferenceDeps } from './context.js';
import type { ReferenceTx } from './ports.js';

/**
 * Calendário e grade horária (Pregão §3, RN-CAL-001..003, RN-SBX-002). O serviço é o dono:
 * responde às funções de calendário e publica `calendar.updated`/`session_schedule.updated` com os
 * dados completos para a cópia local dos consumidores (D15).
 */
export class CalendarService implements ChangeExecutor {
  /** Cópia em memória, refeita quando a versão no banco muda (outra instância ou aprovação). */
  private cached: { version: number; data: CalendarData; calendar: TradingCalendar } | undefined;

  constructor(
    private readonly d: ReferenceDeps,
    private readonly requests: ChangeRequests,
  ) {
    requests.register(['CALENDAR', 'SESSION_SCHEDULE'], this);
  }

  /** Calendário vigente, a partir da transação dada (vê as mudanças ainda não confirmadas). */
  async current(tx: ReferenceTx): Promise<TradingCalendar> {
    return (await this.load(tx)).calendar;
  }

  async data(tx: ReferenceTx): Promise<CalendarData> {
    return (await this.load(tx)).data;
  }

  /** Para as rotas de consulta: fora de transação de negócio. */
  read<T>(fn: (cal: TradingCalendar, data: CalendarData) => T): Promise<T> {
    return this.d.store.transaction(async (tx) => {
      const c = await this.load(tx);
      return fn(c.calendar, c.data);
    });
  }

  private async load(tx: ReferenceTx) {
    const version = await tx.calendarVersion();
    if (this.cached?.version === version) return this.cached;
    const data = toCalendarData(
      await tx.calendarDays(),
      await tx.schedules(),
      this.d.allDaysBusiness,
    );
    const loaded = { version, data, calendar: new TradingCalendar(data) };
    this.cached = loaded;
    return loaded;
  }

  // ---------------------------------------------------------------- propostas (Backoffice §3: com aprovação)

  /** Dias especiais e extensão do período: validados ao propor e de novo ao executar. */
  async requestChange(op: Operator, change: CalendarChange, justification: string) {
    return this.d.store.transaction(async (tx) => {
      planCalendarChange(range(await this.data(tx)), change, this.today());
      return requestView(
        await this.requests.create(tx, op, {
          type: 'CALENDAR',
          targetId: 'calendar',
          payload: change as Record<string, unknown>,
          justification,
        }),
      );
    });
  }

  async requestSchedule(
    op: Operator,
    schedule: Omit<StoredSchedule, 'id' | 'validTo'>,
    justification: string,
  ) {
    return this.d.store.transaction(async (tx) => {
      planSchedule(await tx.schedules(), schedule, this.today());
      return requestView(
        await this.requests.create(tx, op, {
          type: 'SESSION_SCHEDULE',
          targetId: `schedule:${schedule.dayType}`,
          payload: schedule as unknown as Record<string, unknown>,
          justification,
        }),
      );
    });
  }

  /** Qualquer mudança aprovada no calendário invalida as propostas feitas antes dela. */
  async currentState(tx: ReferenceTx) {
    return { calendarVersion: await tx.calendarVersion() };
  }

  execute(tx: ReferenceTx, r: ChangeRequest): Promise<void> {
    return r.type === 'CALENDAR' ? this.applyChange(tx, r) : this.applySchedule(tx, r);
  }

  async schedules(): Promise<StoredSchedule[]> {
    return this.d.store.transaction((tx) => tx.schedules());
  }

  /** Execução aprovada de `CALENDAR`: grava os dias e publica `calendar.updated`. */
  async applyChange(tx: ReferenceTx, r: ChangeRequest): Promise<void> {
    await tx.calendarVersion({ lock: true });
    const data = await this.data(tx);
    const plan = planCalendarChange(range(data), r.payload as CalendarChange, this.today());
    await tx.upsertCalendarDays(plan.rows);
    await tx.bumpCalendarVersion();
    await tx.publish(
      {
        type: 'calendar.updated',
        payload: {
          from: plan.affected.from.toString(),
          to: plan.affected.to.toString(),
          calendar: await this.data(tx),
        },
      },
      'calendar',
    );
  }

  /** Execução aprovada de `SESSION_SCHEDULE`: nova vigência e `session_schedule.updated`. */
  async applySchedule(tx: ReferenceTx, r: ChangeRequest): Promise<void> {
    await tx.calendarVersion({ lock: true });
    const proposed = r.payload as unknown as Omit<StoredSchedule, 'id' | 'validTo'>;
    const { close } = planSchedule(await tx.schedules(), proposed, this.today());
    if (close)
      await tx.closeSchedule(
        close.id,
        BusinessDate.parse(proposed.validFrom).plusDays(-1).toString(),
      );
    await tx.insertSchedule({ ...proposed, id: this.d.newId(), validTo: null });
    await tx.bumpCalendarVersion();
    await tx.publish(
      {
        type: 'session_schedule.updated',
        payload: { from: proposed.validFrom, to: null, calendar: await this.data(tx) },
      },
      'calendar',
    );
  }

  /**
   * Rotina diária (RN-CAL-001): faltando 60 dias para o fim do calendário carregado, alerta o
   * backoffice, uma vez por fim de período.
   */
  async checkCoverage(
    tx: ReferenceTx,
    openTask: (t: {
      kind: 'CALENDAR_COVERAGE_ENDING';
      dedupeKey: string;
      instrumentId: null;
      data: Record<string, unknown>;
      message: string;
    }) => Promise<boolean>,
  ): Promise<{ coverageEnd: string; daysLeft: number; alerted: boolean }> {
    const data = await this.data(tx);
    const end = BusinessDate.parse(data.coverage.to);
    const { daysLeft, alert } = coverageStatus(this.today(), end);
    const alerted =
      alert &&
      (await openTask({
        kind: 'CALENDAR_COVERAGE_ENDING',
        dedupeKey: `coverage:${data.coverage.to}`,
        instrumentId: null,
        data: { coverageEnd: data.coverage.to, daysLeft },
        message: `O calendário carregado acaba em ${data.coverage.to} (faltam ${daysLeft} dias): carregue o próximo ano.`,
      }));
    return { coverageEnd: data.coverage.to, daysLeft, alerted };
  }

  private today(): BusinessDate {
    return this.d.clock.now().businessDate();
  }
}

const range = (data: CalendarData) => ({
  from: BusinessDate.parse(data.coverage.from),
  to: BusinessDate.parse(data.coverage.to),
});
