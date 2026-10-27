import type { ScheduledPhase, SessionSchedule } from '@broker/calendar';
import type { Instant } from '@broker/domain-kernel';

/** Quando ler cada instrumento de novo (RN-BRP-050). */
export interface ReadSchedule {
  nextReadAt: Instant;
  /** Leituras seguidas sem mudança de `quote_time` (até 3 retentativas de +5 min). */
  unchangedRetries: number;
}

export interface NextReadInput {
  now: Instant;
  /** `quote_time` da leitura anterior (`null` na primeira). */
  previousQuoteTime: Instant | null;
  /** `quote_time` desta leitura (`null` quando a leitura falhou). */
  quoteTime: Instant | null;
  unchangedRetries: number;
  /** `brapi.plan.update_interval` (padrão 30 min), já ajustado pelo nível do orçamento. */
  updateIntervalMs: number;
  /** Folga aleatória entre 60 e 180 s, sorteada por quem chama (espalha as requisições). */
  jitterMs: number;
  /** Padrão 5 min e 3 vezes. */
  retryMs?: number;
  maxUnchangedRetries?: number;
}

/**
 * Agendamento adaptativo (RN-BRP-050): a fonte atualiza a cada `update_interval`, então ler antes
 * disso desperdiça cota. Com `quote_time` novo, a próxima leitura é em
 * `quote_time + update_interval + folga`, nunca antes de `agora + 5 min` (a leitura atrasada não
 * dispara outra na hora). Sem mudança, tenta de novo em +5 min até 3 vezes e depois volta ao ciclo
 * normal (`agora + update_interval`).
 */
export function nextRead(input: NextReadInput): ReadSchedule {
  const retryMs = input.retryMs ?? 300_000;
  const maxRetries = input.maxUnchangedRetries ?? 3;
  const changed =
    input.quoteTime !== null &&
    (input.previousQuoteTime === null || input.quoteTime.isAfter(input.previousQuoteTime));
  if (changed) {
    const candidate = input.quoteTime!.plusMillis(input.updateIntervalMs + input.jitterMs);
    const floor = input.now.plusMillis(retryMs);
    return { nextReadAt: candidate.isAfter(floor) ? candidate : floor, unchangedRetries: 0 };
  }
  if (input.unchangedRetries < maxRetries)
    return {
      nextReadAt: input.now.plusMillis(retryMs),
      unchangedRetries: input.unchangedRetries + 1,
    };
  return {
    nextReadAt: input.now.plusMillis(input.updateIntervalMs + input.jitterMs),
    unchangedRetries: 0,
  };
}

/** Folga de RN-BRP-050 a partir de um uniforme em [0, 1). */
export const jitterMs = (u: number) => 60_000 + Math.floor(u * 120_000);

/**
 * Janela de leituras de cotação do dia (RN-BRP-051/053): da abertura do contínuo + 5 min (≈ 10:05,
 * dados de abertura) até o fim do call de fechamento. Sem pregão (fim de semana, feriado), `null`:
 * nenhuma requisição de cotação. A leitura das 18:00 (RN-BRP-052) é a rotina pós-fechamento.
 */
export function quoteWindow(
  schedule: SessionSchedule | null,
  firstReadDelayMs = 300_000,
): { from: Instant; to: Instant } | null {
  if (!schedule) return null;
  const continuous = schedule.phases.find((p) => p.phase === 'CONTINUOUS');
  if (!continuous) return null;
  const last =
    schedule.phases.find((p) => p.phase === 'CLOSING_CALL') ??
    schedule.phases[schedule.phases.length - 1]!;
  return { from: continuous.startsAt.plusMillis(firstReadDelayMs), to: last.endsAt };
}

export function insideWindow(window: { from: Instant; to: Instant } | null, now: Instant): boolean {
  return window !== null && !now.isBefore(window.from) && now.isBefore(window.to);
}

/** Fase da grade no instante (sem pregão ou fora das janelas: `CLOSED`). */
export function phaseAt(schedule: SessionSchedule | null, now: Instant): ScheduledPhase {
  if (!schedule) return 'CLOSED';
  for (const p of schedule.phases)
    if (!now.isBefore(p.startsAt) && now.isBefore(p.endsAt)) return p.phase;
  return 'CLOSED';
}

/**
 * Defasagem (RN-BRP-070): durante o pregão, a cotação é defasada quando
 * `agora − quote_time > update_interval + 15 min` (padrão 45 min). Fora do pregão nada envelhece, e
 * a idade só conta a partir do início da janela de leituras (`sessionStart`): o fechamento de ontem
 * não é defasado às 10:05, antes da primeira leitura do dia.
 */
export function isStale(input: {
  now: Instant;
  quoteTime: Instant;
  updateIntervalMs: number;
  inSession: boolean;
  sessionStart?: Instant;
  graceMs?: number;
}): boolean {
  if (!input.inSession) return false;
  const limit = input.updateIntervalMs + (input.graceMs ?? 900_000);
  const since =
    input.sessionStart && input.sessionStart.isAfter(input.quoteTime)
      ? input.sessionStart
      : input.quoteTime;
  return input.now.epochMillis - since.epochMillis > limit;
}
