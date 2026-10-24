import type { BusinessDate } from '@broker/domain-kernel';
import { plusMonths } from './dates.js';

export type Profile = 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE';

export interface Questionnaire {
  version: number;
  questions: {
    id: string;
    text: string;
    options: { id: string; text: string; weight: number }[];
  }[];
  /** Faixas parametrizáveis (RN-SUI-003): `min` inclusivo, em ordem crescente. */
  bands: { profile: Profile; min: number }[];
}

export class SuitabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Soma os pesos das alternativas escolhidas; toda pergunta precisa de exatamente uma resposta. */
export function score(q: Questionnaire, answers: Record<string, string>): number {
  let total = 0;
  for (const question of q.questions) {
    const chosen = question.options.find((o) => o.id === answers[question.id]);
    if (!chosen)
      throw new SuitabilityError('SUITABILITY_INCOMPLETE', `Responda a pergunta ${question.id}.`);
    total += chosen.weight;
  }
  const unknown = Object.keys(answers).filter((k) => !q.questions.some((x) => x.id === k));
  if (unknown.length > 0)
    throw new SuitabilityError(
      'SUITABILITY_INVALID_ANSWER',
      `Pergunta desconhecida: ${unknown[0]}.`,
    );
  return total;
}

export function profileFor(q: Questionnaire, points: number): Profile {
  let profile = q.bands[0]!.profile;
  for (const b of q.bands) if (points >= b.min) profile = b.profile;
  return profile;
}

/** RN-SUI-012: vale 24 meses; aviso 30 dias antes. */
export const SUITABILITY_VALIDITY_MONTHS = 24;
export const SUITABILITY_WARNING_DAYS = 30;

export const suitabilityValidUntil = (assessedOn: BusinessDate): BusinessDate =>
  plusMonths(assessedOn, SUITABILITY_VALIDITY_MONTHS);
