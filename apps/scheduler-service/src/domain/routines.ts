import type { ScheduledPhase, TradingCalendar } from '@broker/calendar';
import { BusinessDate, type Instant } from '@broker/domain-kernel';

/**
 * Quando a rotina roda no dia (Pregão §8): num horário fixo de São Paulo, ou relativa ao início de
 * uma fase da grade do pregão daquele dia. A forma relativa acompanha os dias especiais: na
 * Quarta-feira de Cinzas (`LATE_OPEN`) o `PRE_TRADING` é às 12:00, não às 09:00.
 */
export type RoutineSchedule = { at: string } | { phase: ScheduledPhase; offsetMinutes?: number };

/**
 * Em que dias a rotina existe:
 * - `TRADING`: dias com pregão e liquidação (`BUSINESS_DAY` e `LATE_OPEN`);
 * - `FIRST_BUSINESS_DAY_OF_MONTH`: o primeiro desses dias no mês (taxa de custódia, IR do mês anterior).
 */
export type RoutineDays = 'TRADING' | 'FIRST_BUSINESS_DAY_OF_MONTH';

export interface RoutineDefinition {
  /** Nome estável, `snake_case`: é metade da chave de idempotência (RN-ROT-001). */
  name: string;
  /** Serviço que executa a rotina e publica `routine.completed`/`routine.failed`. */
  owner: string;
  schedule: RoutineSchedule;
  days: RoutineDays;
  /** Rotinas do MESMO dia que precisam estar concluídas antes (RN-ROT-002). */
  dependsOn: readonly string[];
  enabled: boolean;
}

export type ExecutionStatus = 'TRIGGERED' | 'COMPLETED' | 'FAILED';

export interface ExecutionRecord {
  routineName: string;
  businessDate: BusinessDate;
  status: ExecutionStatus;
}

export interface PlannedRoutine {
  definition: RoutineDefinition;
  dueAt: Instant;
}

/** A rotina vale para a data? */
export function appliesOn(
  def: RoutineDefinition,
  date: BusinessDate,
  calendar: TradingCalendar,
): boolean {
  if (!calendar.isBusinessDay(date)) return false;
  if (def.days === 'TRADING') return true;
  // Primeiro dia útil do mês: nenhum dia útil entre o dia 1 e a véspera.
  const first = BusinessDate.parse(`${date.toString().slice(0, 8)}01`);
  for (let d = first; d.isBefore(date); d = d.plusDays(1)) {
    if (calendar.isBusinessDay(d)) return false;
  }
  return true;
}

/** Instante em que a rotina vence na data (UTC), ou `null` se ela não existe nesse dia. */
export function dueAt(
  def: RoutineDefinition,
  date: BusinessDate,
  calendar: TradingCalendar,
): Instant | null {
  if (!def.enabled || !appliesOn(def, date, calendar)) return null;
  if ('at' in def.schedule) return date.atLocalTime(def.schedule.at);
  const session = calendar.sessionSchedule(date);
  if (!session) return null;
  const { phase, offsetMinutes = 0 } = def.schedule;
  // `CLOSED` não é uma janela: é o fim da última fase.
  const start =
    phase === 'CLOSED'
      ? session.phases.at(-1)?.endsAt
      : session.phases.find((p) => p.phase === phase)?.startsAt;
  if (!start)
    throw new Error(`a grade de ${date.toString()} não tem a fase ${phase} (rotina ${def.name})`);
  return start.plusMillis(offsetMinutes * 60_000);
}

/** As rotinas da data em ordem de vencimento (empate: ordem alfabética, determinística). */
export function planDate(
  definitions: readonly RoutineDefinition[],
  date: BusinessDate,
  calendar: TradingCalendar,
): PlannedRoutine[] {
  return definitions
    .flatMap((definition) => {
      const at = dueAt(definition, date, calendar);
      return at ? [{ definition, dueAt: at }] : [];
    })
    .sort(
      (a, b) =>
        a.dueAt.epochMillis - b.dueAt.epochMillis ||
        a.definition.name.localeCompare(b.definition.name),
    );
}

export interface Decision {
  /** Rotinas a disparar agora, em ordem (data, horário). */
  trigger: Array<{
    routineName: string;
    businessDate: BusinessDate;
    dueAt: Instant;
    catchUp: boolean;
  }>;
  /** Rotinas vencidas que esperam dependências (RN-ROT-002). */
  waiting: Array<{ routineName: string; businessDate: BusinessDate; missing: string[] }>;
  /**
   * Primeira data que ainda tem rotina por disparar: o próximo `decide` começa dela. Só avança
   * quando todas as rotinas da data foram disparadas, o que garante o catch-up em ordem (RN-ROT-003).
   */
  nextCursor: BusinessDate;
}

/**
 * O que disparar agora (RN-ROT-001..003), sem efeito colateral.
 *
 * Varre as datas a partir de `cursor` até a data de negócio de `now`. Em cada data, as rotinas
 * vencidas saem em ordem de horário; uma rotina com dependência pendente espera, mas as
 * independentes seguem. Uma data só começa quando a anterior teve TODAS as rotinas disparadas:
 * com o sistema fora no dia D, as rotinas de D saem antes das de D+1, inclusive as que dependem
 * da conclusão de outras de D.
 */
export function decide(input: {
  definitions: readonly RoutineDefinition[];
  calendar: TradingCalendar;
  now: Instant;
  cursor: BusinessDate;
  executions: readonly ExecutionRecord[];
}): Decision {
  const { definitions, calendar, now } = input;
  const today = now.businessDate();
  const status = new Map(
    input.executions.map((e) => [`${e.routineName}@${e.businessDate.toString()}`, e.status]),
  );
  const trigger: Decision['trigger'] = [];
  const waiting: Decision['waiting'] = [];

  for (let date = input.cursor; !date.isAfter(today); date = date.plusDays(1)) {
    const key = (name: string) => `${name}@${date.toString()}`;
    let pending = false;
    for (const { definition, dueAt: at } of planDate(definitions, date, calendar)) {
      if (status.has(key(definition.name))) continue;
      if (at.isAfter(now)) {
        pending = true;
        continue;
      }
      const missing = definition.dependsOn.filter((d) => status.get(key(d)) !== 'COMPLETED');
      if (missing.length > 0) {
        waiting.push({ routineName: definition.name, businessDate: date, missing });
        pending = true;
        continue;
      }
      trigger.push({
        routineName: definition.name,
        businessDate: date,
        dueAt: at,
        catchUp: !date.equals(today),
      });
      // Disparada agora: as dependentes desta data enxergam como pendente (não concluída) no mesmo passo.
      status.set(key(definition.name), 'TRIGGERED');
    }
    if (pending) return { trigger, waiting, nextCursor: date };
  }
  return { trigger, waiting, nextCursor: today.plusDays(1) };
}

/** Próximo vencimento de rotina depois de `after` (para o `advance_to` parar em cada horário). */
export function nextDueAfter(input: {
  definitions: readonly RoutineDefinition[];
  calendar: TradingCalendar;
  after: Instant;
  until: Instant;
}): Instant | null {
  const last = input.until.businessDate();
  for (let date = input.after.businessDate(); !date.isAfter(last); date = date.plusDays(1)) {
    for (const { dueAt: at } of planDate(input.definitions, date, input.calendar)) {
      if (at.isAfter(input.after) && !at.isAfter(input.until)) return at;
    }
  }
  return null;
}
