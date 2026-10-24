import { BusinessDate, DomainError, TaxId, type Instant } from '@broker/domain-kernel';

/** Etapa fora de ordem: pular etapas não é permitido. */
export class StepOrderError extends Error {}

/** Estados da solicitação (Onboarding §3) mais o `EXPIRED` de RN-ONB-002. */
export const ONBOARDING_STEPS = [
  'STARTED',
  'CONTACT_VERIFIED',
  'PERSONAL_DATA',
  'ADDRESS',
  'FINANCIAL_PROFILE',
  'DOCUMENTS',
  'SUITABILITY',
  'TERMS',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingStatus =
  | OnboardingStep
  | 'UNDER_REVIEW'
  | 'MANUAL_REVIEW'
  | 'PENDING_CUSTOMER'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED';

/** Estados em que a solicitação ainda conta como ativa para a unicidade do CPF (RN-ONB-004). */
export const ACTIVE_STATUSES: readonly OnboardingStatus[] = [
  ...ONBOARDING_STEPS,
  'UNDER_REVIEW',
  'MANUAL_REVIEW',
  'PENDING_CUSTOMER',
];
export const isEditable = (s: OnboardingStatus) =>
  (ONBOARDING_STEPS as readonly string[]).includes(s) || s === 'PENDING_CUSTOMER';

/** RN-ONB-002: 30 dias sem atividade. */
export const ONBOARDING_IDLE_DAYS = 30;

const order = (s: OnboardingStep) => ONBOARDING_STEPS.indexOf(s);

/**
 * Concluir uma etapa: o status vira essa etapa se ela é a próxima da sequência; refazer uma
 * etapa anterior (rascunho) não volta o progresso. Pular etapa não é permitido.
 */
export function afterStep(current: OnboardingStatus, completed: OnboardingStep): OnboardingStatus {
  if (current === 'PENDING_CUSTOMER') return current;
  const cur = order(current as OnboardingStep);
  const done = order(completed);
  if (done > cur + 1)
    throw new StepOrderError(`Conclua antes a etapa ${ONBOARDING_STEPS[cur + 1]}.`);
  return done > cur ? completed : current;
}

/** A próxima etapa a preencher (o que o app mostra ao retomar, de qualquer canal). */
export function nextStep(status: OnboardingStatus): OnboardingStep | 'SUBMIT' | null {
  if (status === 'TERMS' || status === 'PENDING_CUSTOMER') return 'SUBMIT';
  const i = (ONBOARDING_STEPS as readonly string[]).indexOf(status);
  return i < 0 ? null : (ONBOARDING_STEPS[i + 1] ?? 'SUBMIT');
}

// ------------------------------------------------------------------ validações (Onboarding §4)

export interface FieldIssue {
  field: string;
  code: string;
  message: string;
}

const NAME = /^[\p{L}][\p{L}' -]*[\p{L}]$/u;

export function validateName(field: string, value: string): FieldIssue | null {
  const v = value.trim();
  if (v.length < 2 || v.length > 120 || !NAME.test(v) || v.split(/\s+/).length < 2) {
    return {
      field,
      code: 'INVALID_NAME',
      message: 'Informe nome e sobrenome, só com letras, espaço, apóstrofo e hífen.',
    };
  }
  return null;
}

export function ageOn(birth: BusinessDate, on: BusinessDate): number {
  const [by, bm, bd] = birth.toString().split('-').map(Number) as [number, number, number];
  const [y, m, d] = on.toString().split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** Idade entre 18 e 120 anos na data (RN: `UNDERAGE`). */
export function validateBirthDate(raw: string, today: BusinessDate): FieldIssue | null {
  let birth: BusinessDate;
  try {
    birth = BusinessDate.parse(raw);
  } catch {
    return { field: 'birthDate', code: 'INVALID_DATE', message: 'Data inválida.' };
  }
  const age = ageOn(birth, today);
  if (age < 18)
    return { field: 'birthDate', code: 'UNDERAGE', message: 'É preciso ter 18 anos ou mais.' };
  if (age > 120)
    return { field: 'birthDate', code: 'INVALID_DATE', message: 'Data de nascimento inválida.' };
  return null;
}

export function parseTaxId(raw: string): TaxId | FieldIssue {
  try {
    return TaxId.parse(raw);
  } catch (err) {
    if (err instanceof DomainError)
      return { field: 'taxId', code: 'TAX_ID_INVALID', message: err.message };
    throw err;
  }
}

export const UFS = [
  'AC',
  'AL',
  'AP',
  'AM',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MT',
  'MS',
  'MG',
  'PA',
  'PB',
  'PR',
  'PE',
  'PI',
  'RJ',
  'RN',
  'RS',
  'RO',
  'RR',
  'SC',
  'SP',
  'SE',
  'TO',
] as const;
export const isUf = (v: string) => (UFS as readonly string[]).includes(v);
export const isE164 = (v: string) => /^\+[1-9]\d{7,14}$/.test(v);
export const isCep = (v: string) => /^\d{8}$/.test(v);

export const MARITAL_STATUSES = [
  'SINGLE',
  'MARRIED',
  'STABLE_UNION',
  'DIVORCED',
  'WIDOWED',
  'SEPARATED',
] as const;
export const ID_DOCUMENT_TYPES = ['RG', 'CNH', 'RNE'] as const;
export const OCCUPATIONS = [
  'EMPLOYEE',
  'CIVIL_SERVANT',
  'SELF_EMPLOYED',
  'BUSINESS_OWNER',
  'LIBERAL_PROFESSIONAL',
  'RETIRED',
  'STUDENT',
  'UNEMPLOYED',
  'OTHER',
] as const;

// ------------------------------------------------------------------ decisão do KYC (RN-ONB-010/011/020)

export type KycCheckType =
  'TAX_ID_STATUS' | 'DOCUMENT_QUALITY' | 'FACE_MATCH' | 'WATCHLIST' | 'LIVENESS';
export type KycResult = 'PASS' | 'REVIEW' | 'FAIL';

/** Resultado normalizado de uma verificação; FACE_MATCH pelo score (RN-ONB-020). */
export function normalizeCheck(
  type: KycCheckType,
  providerStatus: string,
  score?: number,
): KycResult {
  if (type === 'FACE_MATCH' && score !== undefined)
    return score >= 80 ? 'PASS' : score >= 50 ? 'REVIEW' : 'FAIL';
  if (providerStatus === 'PASSED') return 'PASS';
  if (providerStatus === 'ATTENTION') return 'REVIEW';
  return 'FAIL';
}

export type KycOutcome = 'APPROVED' | 'MANUAL_REVIEW' | 'REJECTED';

/**
 * Decisão: qualquer reprovação reprova; qualquer "atenção" vai para revisão; PEP ou residência
 * fiscal no exterior força revisão manual mesmo com tudo aprovado (RN-ONB-010/011).
 */
export function decideKyc(
  results: readonly KycResult[],
  profile: { pep: boolean; foreignTaxResidency: boolean },
): {
  outcome: KycOutcome;
  reason: string;
} {
  if (results.includes('FAIL')) return { outcome: 'REJECTED', reason: 'KYC_FAILED' };
  if (results.includes('REVIEW')) return { outcome: 'MANUAL_REVIEW', reason: 'KYC_INCONCLUSIVE' };
  if (profile.pep) return { outcome: 'MANUAL_REVIEW', reason: 'PEP' };
  if (profile.foreignTaxResidency)
    return { outcome: 'MANUAL_REVIEW', reason: 'FOREIGN_TAX_RESIDENCY' };
  return { outcome: 'APPROVED', reason: 'KYC_APPROVED' };
}

export const onboardingExpiresAt = (lastActivity: Instant): Instant =>
  lastActivity.plusMillis(ONBOARDING_IDLE_DAYS * 24 * 3_600_000);
