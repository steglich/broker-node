import { DomainError } from './errors.js';

/** Fuso das datas de negócio (P-02). */
export const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/**
 * Instante em UTC com precisão de milissegundo. Imutável. Serializa em ISO 8601 com `Z` (P-02).
 * O domínio não lê o relógio: um `Instant` sempre vem da porta `Clock` ou de um dado.
 */
export class Instant {
  private constructor(readonly epochMillis: number) {}

  static ofEpochMillis(ms: number): Instant {
    if (!Number.isSafeInteger(ms))
      throw new DomainError('INVALID_INSTANT', `instante inválido: ${ms}`);
    return new Instant(ms);
  }

  /** Só ISO 8601 em UTC com `Z` (ex.: `2026-10-16T20:00:00Z`). */
  static parse(iso: string): Instant {
    if (!ISO_INSTANT.test(iso))
      throw new DomainError('INVALID_INSTANT', `instante precisa ser ISO 8601 UTC com Z: ${iso}`);
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) throw new DomainError('INVALID_INSTANT', `instante inválido: ${iso}`);
    return new Instant(ms);
  }

  plusMillis(ms: number): Instant {
    return Instant.ofEpochMillis(this.epochMillis + ms);
  }

  isBefore(other: Instant): boolean {
    return this.epochMillis < other.epochMillis;
  }

  isAfter(other: Instant): boolean {
    return this.epochMillis > other.epochMillis;
  }

  equals(other: Instant): boolean {
    return this.epochMillis === other.epochMillis;
  }

  /** Data de negócio deste instante no fuso de São Paulo. */
  businessDate(): BusinessDate {
    return BusinessDate.fromInstant(this);
  }

  toString(): string {
    return new Date(this.epochMillis).toISOString();
  }

  toJSON(): string {
    return this.toString();
  }
}

const saoPauloParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function zonedParts(
  instant: Instant,
): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number> {
  const parts = Object.fromEntries(
    saoPauloParts.formatToParts(new Date(instant.epochMillis)).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
    second: Number(parts['second']),
  };
}

/** Dia da semana ISO: 1 = segunda ... 7 = domingo. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * Data de negócio: data sem fuso, calculada em `America/Sao_Paulo` (P-02).
 * Ex.: `2026-10-17T01:30:00Z` é `2026-10-16` em São Paulo (UTC−3).
 */
export class BusinessDate {
  /** Dias desde 1970-01-01 (data civil, sem fuso). */
  private constructor(readonly epochDay: number) {}

  /** A partir de `YYYY-MM-DD`; recusa datas inexistentes (ex.: 2026-02-30). */
  static parse(iso: string): BusinessDate {
    const m = ISO_DATE.exec(iso);
    if (!m) throw new DomainError('INVALID_DATE', `data precisa ser YYYY-MM-DD: ${iso}`);
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const ms = Date.UTC(y, mo - 1, d);
    const check = new Date(ms);
    if (
      check.getUTCFullYear() !== y ||
      check.getUTCMonth() !== mo - 1 ||
      check.getUTCDate() !== d
    ) {
      throw new DomainError('INVALID_DATE', `data inexistente: ${iso}`);
    }
    return new BusinessDate(ms / DAY_MS);
  }

  static fromInstant(instant: Instant): BusinessDate {
    const p = zonedParts(instant);
    return new BusinessDate(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS);
  }

  static ofEpochDay(epochDay: number): BusinessDate {
    if (!Number.isSafeInteger(epochDay))
      throw new DomainError('INVALID_DATE', `dia inválido: ${epochDay}`);
    return new BusinessDate(epochDay);
  }

  plusDays(days: number): BusinessDate {
    return BusinessDate.ofEpochDay(this.epochDay + days);
  }

  /** 1 = segunda ... 7 = domingo. */
  isoWeekday(): IsoWeekday {
    // 1970-01-01 foi quinta-feira (4).
    return (((((this.epochDay + 3) % 7) + 7) % 7) + 1) as IsoWeekday;
  }

  isWeekend(): boolean {
    return this.isoWeekday() >= 6;
  }

  year(): number {
    return new Date(this.epochDay * DAY_MS).getUTCFullYear();
  }

  /**
   * Instante em que esta data, no horário local de São Paulo `HH:MM`, acontece.
   * Usa o deslocamento real do fuso naquele dia (o Brasil não tem horário de verão desde 2019,
   * mas o cálculo não assume isso).
   */
  atLocalTime(hhmm: string): Instant {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
    if (!m) throw new DomainError('INVALID_DATE', `horário precisa ser HH:MM: ${hhmm}`);
    const naiveUtc = this.epochDay * DAY_MS + (Number(m[1]) * 60 + Number(m[2])) * 60_000;
    // Descobre o deslocamento do fuso comparando o horário local de um palpite com o desejado.
    const guess = Instant.ofEpochMillis(naiveUtc);
    const p = zonedParts(guess);
    const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Instant.ofEpochMillis(naiveUtc + (naiveUtc - localAsUtc));
  }

  equals(other: BusinessDate): boolean {
    return this.epochDay === other.epochDay;
  }

  compare(other: BusinessDate): -1 | 0 | 1 {
    return this.epochDay < other.epochDay ? -1 : this.epochDay > other.epochDay ? 1 : 0;
  }

  isBefore(other: BusinessDate): boolean {
    return this.epochDay < other.epochDay;
  }

  isAfter(other: BusinessDate): boolean {
    return this.epochDay > other.epochDay;
  }

  /** `YYYY-MM-DD`. */
  toString(): string {
    return new Date(this.epochDay * DAY_MS).toISOString().slice(0, 10);
  }

  toJSON(): string {
    return this.toString();
  }
}
