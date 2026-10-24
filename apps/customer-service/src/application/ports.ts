import type { BusinessDate, Instant } from '@broker/domain-kernel';
import type { AccountStatus, ClosurePendency, Restriction } from '../domain/account.js';
import type { DocumentType } from '../domain/documents.js';
import type { KycCheckType, KycResult, OnboardingStatus } from '../domain/onboarding.js';
import type { Profile, Questionnaire } from '../domain/suitability.js';
import type { TermsMoment } from '../domain/terms.js';

// ------------------------------------------------------------------ registros

/** Etapas salvas como rascunho, cada uma cifrada como um JSON (RN-ONB-001, RN-DB-031). */
export interface Draft {
  contactEnc?: string;
  personalEnc?: string;
  addressEnc?: string;
  financialEnc?: string;
}

export interface ContactOtp {
  emailHash: string;
  phoneHash: string;
  attempts: number;
  expiresAt: string;
}

export interface ApplicationRow {
  id: string;
  userId: string;
  status: OnboardingStatus;
  draft: Draft;
  taxIdHash: string | null;
  emailHash: string | null;
  contactOtp: ContactOtp | null;
  kycCheckId: string | null;
  customerId: string | null;
  createdAt: Instant;
  lastActivityAt: Instant;
  submittedAt: Instant | null;
  decidedAt: Instant | null;
  decidedBy: string | null;
  decisionReason: string | null;
}

export interface DocumentRow {
  id: string;
  applicationId: string;
  type: DocumentType;
  storageKey: string;
  declaredContentType: string;
  declaredSize: number;
  format: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  status: 'PENDING_UPLOAD' | 'ACCEPTED' | 'REJECTED' | 'PURGED';
  rejectReason: string | null;
  createdAt: Instant;
  purgeAt: Instant | null;
}

export interface KycCheckRow {
  id: string;
  applicationId: string;
  providerCheckId: string;
  checkType: KycCheckType;
  result: KycResult;
  score: number | null;
  rawPayload: unknown;
  receivedAt: Instant;
}

export interface CustomerRow {
  id: string;
  userId: string;
  applicationId: string;
  fullNameEnc: string;
  socialNameEnc: string | null;
  taxIdEnc: string;
  taxIdHash: string;
  birthDateEnc: string;
  nationality: string;
  maritalStatus: string;
  motherNameEnc: string;
  gender: string | null;
  emailEnc: string;
  emailHash: string;
  phoneEnc: string;
  addressEnc: string;
  idDocumentEnc: string;
  pep: boolean;
  foreignTaxResidency: boolean;
  occupation: string;
  monthlyIncome: string;
  declaredNetWorth: string;
  status: 'ACTIVE' | 'CLOSED';
  registrationValidUntil: BusinessDate;
  createdAt: Instant;
}

export interface AccountRow {
  id: string;
  customerId: string;
  accountNumber: string;
  status: AccountStatus;
  restrictions: Restriction[];
  marginEnabled: boolean;
  bankAccountId: string | null;
  openedAt: Instant;
  closedAt: Instant | null;
}

export interface QuestionnaireRow extends Questionnaire {
  id: string;
}

export interface AssessmentRow {
  id: string;
  userId: string;
  questionnaireId: string;
  questionnaireVersion: number;
  answers: Record<string, string>;
  score: number;
  profile: Profile;
  assessedAt: Instant;
  validUntil: BusinessDate;
  expiringNotified: boolean;
  expiredNotified: boolean;
}

export interface TermsRow {
  id: string;
  code: string;
  version: number;
  title: string;
  content: string;
  contentHash: string;
  mandatory: boolean;
  moment: TermsMoment;
  validFrom: Instant;
}

export interface WithdrawalAccountRow {
  id: string;
  accountId: string;
  pixKeyEnc: string;
  pixKeyHash: string;
  pixKeyType: string;
  holderNameMasked: string;
  status: 'ACTIVE' | 'REMOVED';
  availableFrom: Instant;
  createdAt: Instant;
}

export type ChangeKind = 'EMAIL' | 'PHONE' | 'ADDRESS' | 'NAME' | 'ID_DOCUMENT';

export interface ProfileChangeRow {
  id: string;
  customerId: string;
  kind: ChangeKind;
  newValueEnc: string;
  /** Documento novo exigido pela troca de nome ou documento (RN-CAD-002). */
  documentKey: string | null;
  otpOldHash: string | null;
  otpNewHash: string | null;
  attempts: number;
  status: 'PENDING_OTP' | 'PENDING_REVIEW' | 'APPLIED' | 'REJECTED' | 'EXPIRED';
  createdAt: Instant;
  expiresAt: Instant | null;
  decidedBy: string | null;
}

/** Eventos publicados pela outbox (contratos `onboarding.*`, `customer.*`, `account.*`...). */
export type CustomerEvent =
  | { type: 'onboarding.started'; payload: { applicationId: string; userId: string } }
  | { type: 'onboarding.step_completed'; payload: { applicationId: string; step: string } }
  | { type: 'onboarding.submitted'; payload: { applicationId: string } }
  | {
      type: 'onboarding.kyc_completed';
      payload: {
        applicationId: string;
        outcome: 'APPROVED' | 'MANUAL_REVIEW' | 'REJECTED';
        checks: { type: string; result: string }[];
      };
    }
  | {
      type: 'onboarding.approved' | 'onboarding.rejected';
      payload: {
        applicationId: string;
        customerId?: string;
        reasonCode?: string;
        decidedBy?: string;
      };
    }
  | {
      type: 'customer.created';
      payload: {
        customerId: string;
        userId: string;
        displayName: string;
        declaredNetWorth: string;
        pep: boolean;
      };
    }
  | {
      type: 'customer.updated';
      payload: { customerId: string; changedFields: string[]; declaredNetWorth?: string };
    }
  | {
      type: 'account.opened';
      payload: { accountId: string; customerId: string; accountNumber: string; openedAt: string };
    }
  | {
      type: 'account.status_changed';
      payload: {
        accountId: string;
        from: string;
        to: string;
        reasonCode: string;
        restrictions?: string[];
        actor: { type: string; id: string };
      };
    }
  | {
      type: 'suitability.assessed';
      payload: {
        customerId: string;
        accountId?: string;
        profile: Profile;
        score: number;
        validUntil: string;
        questionnaireVersion: number;
      };
    }
  | {
      type: 'suitability.expiring' | 'suitability.expired';
      payload: { customerId: string; validUntil: string };
    }
  | {
      type: 'terms.accepted';
      payload: { userId: string; termsCode: string; version: number; acceptedAt: string };
    };

// ------------------------------------------------------------------ banco

export interface CustomerTx {
  application(id: string, opts?: { forUpdate?: boolean }): Promise<ApplicationRow | null>;
  applicationOfUser(userId: string, opts?: { forUpdate?: boolean }): Promise<ApplicationRow | null>;
  applicationByKycCheck(
    checkId: string,
    opts?: { forUpdate?: boolean },
  ): Promise<ApplicationRow | null>;
  /** `false` se o usuário já tem solicitação (idempotência do início). */
  insertApplication(a: ApplicationRow): Promise<boolean>;
  /** Grava a solicitação; `TAX_ID_TAKEN` se outra solicitação ativa já usa o CPF. */
  saveApplication(a: ApplicationRow): Promise<'OK' | 'TAX_ID_TAKEN'>;
  applicationsIdleSince(before: Instant, limit: number): Promise<ApplicationRow[]>;
  reviewQueue(limit: number): Promise<ApplicationRow[]>;

  documents(applicationId: string): Promise<DocumentRow[]>;
  document(id: string, opts?: { forUpdate?: boolean }): Promise<DocumentRow | null>;
  insertDocument(d: DocumentRow): Promise<void>;
  saveDocument(d: DocumentRow): Promise<void>;

  /** `false` se o (check_id, tipo) já estava gravado (webhook repetido). */
  insertKycCheck(c: KycCheckRow): Promise<boolean>;
  kycChecks(applicationId: string): Promise<KycCheckRow[]>;

  customer(id: string): Promise<CustomerRow | null>;
  customerOfUser(userId: string): Promise<CustomerRow | null>;
  customerOfApplication(applicationId: string): Promise<CustomerRow | null>;
  /** CPF com cliente não encerrado (RN-ONB-004). */
  openCustomerWithTaxId(taxIdHash: string): Promise<boolean>;
  emailInUse(emailHash: string, exceptUserId: string): Promise<boolean>;
  insertCustomer(c: CustomerRow): Promise<void>;
  updateCustomer(
    id: string,
    patch: Partial<
      Pick<
        CustomerRow,
        | 'fullNameEnc'
        | 'emailEnc'
        | 'emailHash'
        | 'phoneEnc'
        | 'addressEnc'
        | 'idDocumentEnc'
        | 'registrationValidUntil'
        | 'status'
      >
    >,
  ): Promise<void>;
  customersWithRegistrationBefore(date: BusinessDate, limit: number): Promise<CustomerRow[]>;

  nextAccountSeq(): Promise<number>;
  account(id: string, opts?: { forUpdate?: boolean }): Promise<AccountRow | null>;
  accountOfCustomer(customerId: string, opts?: { forUpdate?: boolean }): Promise<AccountRow | null>;
  insertAccount(a: AccountRow): Promise<void>;
  saveAccount(a: AccountRow): Promise<void>;

  currentQuestionnaire(): Promise<QuestionnaireRow>;
  insertAssessment(a: AssessmentRow): Promise<void>;
  latestAssessment(userId: string): Promise<AssessmentRow | null>;
  /** Avaliações mais recentes de cada usuário com `valid_until` até a data e sem o aviso marcado. */
  assessmentsToNotify(
    kind: 'EXPIRING' | 'EXPIRED',
    until: BusinessDate,
    limit: number,
  ): Promise<AssessmentRow[]>;
  markAssessmentNotified(id: string, kind: 'EXPIRING' | 'EXPIRED'): Promise<void>;

  currentTerms(): Promise<TermsRow[]>;
  terms(id: string): Promise<TermsRow | null>;
  latestTermsVersion(code: string): Promise<TermsRow | null>;
  insertTerms(t: TermsRow): Promise<void>;
  acceptedTermsIds(userId: string): Promise<Set<string>>;
  insertAcceptance(a: {
    id: string;
    userId: string;
    termsId: string;
    acceptedAt: Instant;
    ip: string | null;
    userAgent: string | null;
    channel: string;
    contentHash: string;
  }): Promise<boolean>;

  withdrawalAccounts(accountId: string): Promise<WithdrawalAccountRow[]>;
  withdrawalAccount(id: string): Promise<WithdrawalAccountRow | null>;
  insertWithdrawalAccount(w: WithdrawalAccountRow): Promise<'OK' | 'DUPLICATE'>;
  removeWithdrawalAccount(id: string): Promise<void>;

  profileChange(id: string, opts?: { forUpdate?: boolean }): Promise<ProfileChangeRow | null>;
  insertProfileChange(c: ProfileChangeRow): Promise<void>;
  saveProfileChange(c: ProfileChangeRow): Promise<void>;
  pendingReviews(limit: number): Promise<ProfileChangeRow[]>;
  insertHistory(h: {
    id: string;
    customerId: string;
    field: string;
    oldValueEnc: string | null;
    newValueEnc: string | null;
    actorId: string;
    at: Instant;
  }): Promise<void>;
  history(customerId: string): Promise<{ field: string; actorId: string; at: Instant }[]>;

  publish(event: CustomerEvent, partitionKey: string): Promise<void>;
}

export interface CustomerStore {
  transaction<T>(fn: (tx: CustomerTx) => Promise<T>): Promise<T>;
}

// ------------------------------------------------------------------ integrações

export interface FieldProtection {
  seal(value: string, context: string): string;
  open(stored: string, context: string): string;
  /** HMAC de busca (CPF, e-mail, chave PIX), RN-DB-031. */
  hash(value: string, context: string): string;
}

export interface Randomness {
  digits(n: number): string;
  sha256(value: string): string;
}

/** Storage dos documentos (bucket `documents`, URLs pré-assinadas, D16). */
export interface DocumentStorage {
  uploadUrl(key: string, contentType: string, size: number, ttlSeconds: number): Promise<string>;
  downloadUrl(key: string, ttlSeconds: number): Promise<string>;
  /** Tamanho, SHA-256 e os primeiros bytes; `null` se o objeto não existe. */
  inspect(key: string): Promise<{ size: number; sha256: string; head: Uint8Array } | null>;
  remove(key: string): Promise<void>;
}

/** ACL do KYC simulado (RN-ONB-021): submissão; o resultado chega por webhook. */
export interface KycProvider {
  submit(input: {
    referenceId: string;
    taxId: string;
    fullName: string;
    birthDate: string;
    documents: { type: 'ID_FRONT' | 'ID_BACK' | 'SELFIE'; url: string }[];
  }): Promise<{ checkId: string }>;
}

/** ACL do Banco Simulado (Sistemas simulados §2). */
export interface BankPort {
  openAccount(taxId: string, name: string): Promise<{ id: string }>;
  /** Titular de uma chave PIX; `null` se a chave não existe. */
  lookupKey(
    key: string,
  ): Promise<{ type: string; holderTaxId: string | null; holderNameMasked: string } | null>;
}

/** Verificador de pendências de encerramento de um serviço dono (RN-ACC-012). */
export interface ClosureCheck {
  source: ClosurePendency['source'];
  pendencies(accountId: string): Promise<ClosurePendency[]>;
}

export interface Messenger {
  email(to: string, subject: string, text: string): Promise<void>;
  sms(to: string, text: string): Promise<void>;
}

export type { ClosurePendency };
