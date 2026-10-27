// Horário de silêncio (RN-NOT-G-006) e retentativa por canal (RN-NOT-G-007).
import { BUSINESS_TIME_ZONE, Instant } from '@broker/domain-kernel';
import type { ExternalChannel } from './catalog.js';

/** Janela local (America/Sao_Paulo) em `HH:MM`; `start > end` atravessa a meia-noite. */
export interface QuietHours {
  start: string;
  end: string;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

const localClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function localMinutes(at: Instant): number {
  const p = Object.fromEntries(
    localClock.formatToParts(new Date(at.epochMillis)).map((x) => [x.type, x.value]),
  );
  return Number(p['hour']) * 60 + Number(p['minute']);
}

export function insideQuietHours(at: Instant, q: QuietHours): boolean {
  const m = localMinutes(at);
  const s = minutes(q.start);
  const e = minutes(q.end);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** Quando a entrega pode sair: o fim da janela, se `at` cai dentro dela; senão o próprio `at`. */
export function releaseAfterQuietHours(at: Instant, q: QuietHours | null): Instant {
  if (!q || !insideQuietHours(at, q)) return at;
  const today = at.businessDate();
  for (const day of [today, today.plusDays(1)]) {
    const end = day.atLocalTime(q.end);
    if (end.isAfter(at)) return end;
  }
  return at;
}

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  /** Prazo total desde a primeira tentativa: depois dele, falha definitiva. */
  windowMs: number;
}

const HOUR = 3_600_000;

/** RN-NOT-G-007: até 24 h para e-mail e 1 h para push; SMS segue o push. */
export const RETRY: Record<ExternalChannel, RetryPolicy> = {
  EMAIL: { baseMs: 60_000, maxMs: HOUR, windowMs: 24 * HOUR },
  PUSH: { baseMs: 15_000, maxMs: 10 * 60_000, windowMs: HOUR },
  SMS: { baseMs: 30_000, maxMs: 10 * 60_000, windowMs: HOUR },
};

/** Próxima tentativa (backoff exponencial) ou `null` se passaria do prazo. */
export function nextAttempt(
  policy: RetryPolicy,
  attempts: number,
  now: Instant,
  deadline: Instant,
): Instant | null {
  const delay = Math.min(policy.baseMs * 2 ** Math.max(0, attempts - 1), policy.maxMs);
  const next = now.plusMillis(delay);
  return next.isAfter(deadline) ? null : next;
}
