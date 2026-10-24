import type { Instant } from '@broker/domain-kernel';
import {
  ACCEPTED_CONTENT_TYPES,
  checkDocument,
  MAX_DOCUMENT_BYTES,
  REQUIRED_DOCUMENTS,
  type DocumentType,
} from '../domain/documents.js';
import {
  afterStep,
  decideKyc,
  ID_DOCUMENT_TYPES,
  isCep,
  isE164,
  isEditable,
  isUf,
  MARITAL_STATUSES,
  nextStep,
  normalizeCheck,
  OCCUPATIONS,
  onboardingExpiresAt,
  parseTaxId,
  validateBirthDate,
  validateName,
  type FieldIssue,
  type KycCheckType,
  type OnboardingStep,
} from '../domain/onboarding.js';
import {
  CTX,
  CustomerError,
  HASH,
  invalid,
  notFound,
  openJson,
  rule,
  sealJson,
  type CustomerDeps,
  type Operator,
} from './context.js';
import type { ApplicationRow, CustomerTx, DocumentRow } from './ports.js';

const OTP_TTL_MS = 10 * 60_000;
const OTP_ATTEMPTS = 5;
const UPLOAD_URL_TTL_S = 10 * 60;
const KYC_URL_TTL_S = 30 * 60;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONEY = /^\d{1,16}(\.\d{1,2})?$/;

export interface Contact {
  email: string;
  phone: string;
}
export interface IdDocument {
  type: (typeof ID_DOCUMENT_TYPES)[number];
  number: string;
  issuer: string;
  issuerState: string;
  issueDate: string;
}
export interface PersonalData {
  fullName: string;
  socialName?: string;
  taxId: string;
  birthDate: string;
  nationality: 'BRAZILIAN' | 'FOREIGN_RESIDENT';
  maritalStatus: (typeof MARITAL_STATUSES)[number];
  motherName: string;
  gender?: string;
  idDocument: IdDocument;
}
export interface Address {
  zipCode: string;
  street: string;
  number: string;
  complement?: string;
  district: string;
  city: string;
  state: string;
}
export interface FinancialProfile {
  occupation: (typeof OCCUPATIONS)[number];
  monthlyIncome: string;
  declaredNetWorth: string;
  pep: boolean;
  linkedPerson: boolean;
  fundsOrigin: string;
  foreignTaxResidency: boolean;
}

/** Validação de campo com a lista de problemas (o primeiro vira o erro da resposta). */
function assertNoIssues(issues: (FieldIssue | null)[]): void {
  const first = issues.find((i): i is FieldIssue => i !== null);
  if (!first) return;
  // A idade é regra de negócio (`UNDERAGE`), não formato.
  if (first.code === 'UNDERAGE')
    throw new CustomerError(422, 'UNDERAGE', first.message, first.field);
  throw invalid(first.field, first.code, first.message);
}

/**
 * Onboarding (Contas §3–§5): etapas como rascunho retomável, validações, unicidade do CPF,
 * documentos por URL assinada, submissão ao KYC simulado e a decisão (RN-ONB-001..022).
 */
export class Onboarding {
  constructor(
    private readonly d: CustomerDeps,
    /** Inicia a saga de abertura de conta depois do commit da aprovação. */
    private readonly startOpening: (applicationId: string) => Promise<void>,
  ) {}

  // ---------------------------------------------------------------- início e leitura

  /** Cria a solicitação do usuário se ainda não existir (evento do identity ou primeira leitura). */
  async ensureStarted(tx: CustomerTx, userId: string): Promise<ApplicationRow> {
    const existing = await tx.applicationOfUser(userId, { forUpdate: true });
    if (existing) return existing;
    const now = this.d.clock.now();
    const app: ApplicationRow = {
      id: this.d.newId(),
      userId,
      status: 'STARTED',
      draft: {},
      taxIdHash: null,
      emailHash: null,
      contactOtp: null,
      kycCheckId: null,
      customerId: null,
      createdAt: now,
      lastActivityAt: now,
      submittedAt: null,
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
    };
    if (!(await tx.insertApplication(app)))
      return (await tx.applicationOfUser(userId, { forUpdate: true }))!;
    await tx.publish(
      { type: 'onboarding.started', payload: { applicationId: app.id, userId } },
      app.id,
    );
    return app;
  }

  async view(userId: string) {
    const { app, docs } = await this.d.store.transaction(async (tx) => {
      const app = await this.ensureStarted(tx, userId);
      return { app, docs: await tx.documents(app.id) };
    });
    const open = <T>(v: string | undefined, ctx: string) =>
      v ? openJson<T>(this.d, v, ctx) : null;
    return {
      applicationId: app.id,
      status: app.status,
      nextStep: nextStep(app.status),
      expiresAt: isEditable(app.status) ? onboardingExpiresAt(app.lastActivityAt).toString() : null,
      contact: open<Contact>(app.draft.contactEnc, CTX.contact),
      personalData: open<PersonalData>(app.draft.personalEnc, CTX.personal),
      address: open<Address>(app.draft.addressEnc, CTX.address),
      financialProfile: open<FinancialProfile>(app.draft.financialEnc, CTX.financial),
      documents: docs
        .filter((x) => x.status !== 'PURGED')
        .map((x) => ({ id: x.id, type: x.type, status: x.status, rejectReason: x.rejectReason })),
      decisionReason: app.decisionReason,
    };
  }

  // ---------------------------------------------------------------- etapas

  /** Contato: grava e-mail e celular e envia um código para cada (Onboarding §4.1). */
  async saveContact(userId: string, input: Contact): Promise<void> {
    const email = input.email.trim().toLowerCase();
    assertNoIssues([
      EMAIL.test(email)
        ? null
        : { field: 'email', code: 'INVALID_EMAIL', message: 'E-mail inválido.' },
      isE164(input.phone)
        ? null
        : { field: 'phone', code: 'INVALID_PHONE', message: 'Use o formato +5511987654321.' },
    ]);
    const emailCode = this.d.random.digits(6);
    const phoneCode = this.d.random.digits(6);
    await this.d.store.transaction(async (tx) => {
      const app = await this.editable(tx, userId);
      if (app.status !== 'STARTED')
        throw rule('CONTACT_ALREADY_VERIFIED', 'O contato já foi verificado.');
      const emailHash = this.d.fields.hash(email, HASH.email);
      if (await tx.emailInUse(emailHash, userId))
        throw rule('EMAIL_ALREADY_IN_USE', 'Esse e-mail já está em uso.');
      app.draft.contactEnc = sealJson(this.d, { email, phone: input.phone }, CTX.contact);
      app.contactOtp = {
        emailHash: this.d.random.sha256(emailCode),
        phoneHash: this.d.random.sha256(phoneCode),
        attempts: 0,
        expiresAt: this.d.clock.now().plusMillis(OTP_TTL_MS).toString(),
      };
      await this.save(tx, app);
    });
    await this.d.messenger.email(
      email,
      'Código de verificação',
      `Seu código de verificação de e-mail: ${emailCode}`,
    );
    await this.d.messenger.sms(
      input.phone,
      `Seu código de verificação: ${phoneCode}. Não compartilhe.`,
    );
  }

  async verifyContact(
    userId: string,
    codes: { emailCode: string; phoneCode: string },
  ): Promise<void> {
    const result = await this.d.store.transaction(async (tx) => {
      const app = await this.editable(tx, userId);
      const otp = app.contactOtp;
      if (!otp || !app.draft.contactEnc)
        throw rule('CONTACT_NOT_STARTED', 'Informe e-mail e celular antes.');
      if (
        otp.attempts >= OTP_ATTEMPTS ||
        Date.parse(otp.expiresAt) < this.d.clock.now().epochMillis
      )
        throw rule('OTP_EXPIRED', 'Os códigos expiraram. Peça novos.');
      if (
        otp.emailHash !== this.d.random.sha256(codes.emailCode) ||
        otp.phoneHash !== this.d.random.sha256(codes.phoneCode)
      ) {
        app.contactOtp = { ...otp, attempts: otp.attempts + 1 };
        await this.save(tx, app);
        return { error: invalid('code', 'INVALID_OTP', 'Código incorreto.') };
      }
      const contact = openJson<Contact>(this.d, app.draft.contactEnc, CTX.contact);
      app.contactOtp = null;
      app.emailHash = this.d.fields.hash(contact.email, HASH.email);
      await this.complete(tx, app, 'CONTACT_VERIFIED');
      return { ok: true as const };
    });
    if ('error' in result) throw result.error;
  }

  /** Dados pessoais: validações, CPF único e idade entre 18 e 120 anos (RN-ONB-004). */
  async savePersonal(userId: string, p: PersonalData): Promise<void> {
    const today = this.d.clock.now().businessDate();
    const taxId = parseTaxId(p.taxId);
    assertNoIssues([
      validateName('fullName', p.fullName),
      p.socialName ? validateName('socialName', p.socialName) : null,
      'field' in taxId ? taxId : null,
      validateBirthDate(p.birthDate, today),
      validateName('motherName', p.motherName),
      p.idDocument.number.trim() === ''
        ? {
            field: 'idDocument.number',
            code: 'REQUIRED',
            message: 'Informe o número do documento.',
          }
        : null,
      isUf(p.idDocument.issuerState)
        ? null
        : { field: 'idDocument.issuerState', code: 'INVALID_STATE', message: 'UF inválida.' },
      /^\d{4}-\d{2}-\d{2}$/.test(p.idDocument.issueDate) &&
      p.idDocument.issueDate <= today.toString()
        ? null
        : {
            field: 'idDocument.issueDate',
            code: 'INVALID_DATE',
            message: 'Data de emissão inválida.',
          },
    ]);
    const digits = (taxId as { digits: string }).digits;
    await this.d.store.transaction(async (tx) => {
      const app = await this.editable(tx, userId);
      const taxIdHash = this.d.fields.hash(digits, HASH.taxId);
      if (await tx.openCustomerWithTaxId(taxIdHash)) throw taxIdTaken();
      app.taxIdHash = taxIdHash;
      app.draft.personalEnc = sealJson(this.d, { ...p, taxId: digits }, CTX.personal);
      await this.complete(tx, app, 'PERSONAL_DATA');
    });
  }

  async saveAddress(userId: string, a: Address): Promise<void> {
    assertNoIssues([
      isCep(a.zipCode)
        ? null
        : { field: 'zipCode', code: 'INVALID_ZIP_CODE', message: 'CEP com 8 dígitos.' },
      a.street.trim()
        ? null
        : { field: 'street', code: 'REQUIRED', message: 'Informe o logradouro.' },
      a.number.trim() ? null : { field: 'number', code: 'REQUIRED', message: 'Informe o número.' },
      a.district.trim()
        ? null
        : { field: 'district', code: 'REQUIRED', message: 'Informe o bairro.' },
      a.city.trim() ? null : { field: 'city', code: 'REQUIRED', message: 'Informe a cidade.' },
      isUf(a.state) ? null : { field: 'state', code: 'INVALID_STATE', message: 'UF inválida.' },
    ]);
    await this.d.store.transaction(async (tx) => {
      const app = await this.editable(tx, userId);
      app.draft.addressEnc = sealJson(this.d, a, CTX.address);
      await this.complete(tx, app, 'ADDRESS');
    });
  }

  async saveFinancial(userId: string, f: FinancialProfile): Promise<void> {
    assertNoIssues([
      (OCCUPATIONS as readonly string[]).includes(f.occupation)
        ? null
        : { field: 'occupation', code: 'INVALID_OCCUPATION', message: 'Ocupação inválida.' },
      MONEY.test(f.monthlyIncome) && Number(f.monthlyIncome) > 0
        ? null
        : {
            field: 'monthlyIncome',
            code: 'INVALID_AMOUNT',
            message: 'A renda precisa ser maior que zero.',
          },
      MONEY.test(f.declaredNetWorth)
        ? null
        : { field: 'declaredNetWorth', code: 'INVALID_AMOUNT', message: 'Patrimônio inválido.' },
      f.fundsOrigin.trim()
        ? null
        : { field: 'fundsOrigin', code: 'REQUIRED', message: 'Informe a origem dos recursos.' },
    ]);
    await this.d.store.transaction(async (tx) => {
      const app = await this.editable(tx, userId);
      app.draft.financialEnc = sealJson(this.d, f, CTX.financial);
      await this.complete(tx, app, 'FINANCIAL_PROFILE');
    });
  }

  // ---------------------------------------------------------------- documentos (Onboarding §5.1)

  /**
   * URL pré-assinada para o upload direto ao storage. O nome do objeto é do servidor, e o tipo e o
   * tamanho declarados já são conferidos aqui: um arquivo de 12 MB nem recebe URL.
   */
  async requestUpload(
    userId: string,
    input: { type: DocumentType; contentType: string; sizeBytes: number },
  ) {
    if (
      !(ACCEPTED_CONTENT_TYPES as readonly string[]).includes(input.contentType) ||
      input.sizeBytes > MAX_DOCUMENT_BYTES ||
      input.sizeBytes <= 0
    ) {
      throw rule('DOCUMENT_INVALID_FORMAT', 'Envie JPEG, PNG ou PDF com até 10 MB.', {
        reason: input.sizeBytes > MAX_DOCUMENT_BYTES ? 'TOO_LARGE' : 'UNSUPPORTED_FORMAT',
      });
    }
    const id = this.d.newId();
    const now = this.d.clock.now();
    const key = await this.d.store.transaction(async (tx) => {
      const app = await this.editable(tx, userId);
      this.requireStepDone(app, 'FINANCIAL_PROFILE');
      const doc: DocumentRow = {
        id,
        applicationId: app.id,
        type: input.type,
        storageKey: `onboarding/${app.id}/${id}`,
        declaredContentType: input.contentType,
        declaredSize: input.sizeBytes,
        format: null,
        sizeBytes: null,
        sha256: null,
        width: null,
        height: null,
        status: 'PENDING_UPLOAD',
        rejectReason: null,
        createdAt: now,
        purgeAt: null,
      };
      await tx.insertDocument(doc);
      await this.touch(tx, app);
      return doc.storageKey;
    });
    const uploadUrl = await this.d.documents.uploadUrl(
      key,
      input.contentType,
      input.sizeBytes,
      UPLOAD_URL_TTL_S,
    );
    return {
      documentId: id,
      uploadUrl,
      expiresAt: now.plusMillis(UPLOAD_URL_TTL_S * 1000).toString(),
    };
  }

  /** Registra o documento enviado: confere tamanho, tipo pelos bytes e resolução (800×600). */
  async confirmDocument(userId: string, documentId: string) {
    const result = await this.d.store.transaction(async (tx) => {
      const app = await this.editable(tx, userId);
      const doc = await tx.document(documentId, { forUpdate: true });
      if (!doc || doc.applicationId !== app.id) throw notFound('Documento inexistente.');
      if (doc.status === 'ACCEPTED') return { doc };
      if (doc.status !== 'PENDING_UPLOAD')
        throw rule('DOCUMENT_INVALID_FORMAT', 'Documento recusado; envie outro.');
      const found = await this.d.documents.inspect(doc.storageKey);
      const check = checkDocument(found?.size ?? 0, found?.head ?? null);
      if (typeof check === 'string') {
        if (check !== 'NOT_UPLOADED') await this.d.documents.remove(doc.storageKey);
        if (check === 'NOT_UPLOADED')
          return { error: rule('DOCUMENT_NOT_UPLOADED', 'O arquivo ainda não foi enviado.') };
        await tx.saveDocument({
          ...doc,
          status: 'REJECTED',
          rejectReason: check,
          sizeBytes: found?.size ?? null,
        });
        return {
          error: rule(
            'DOCUMENT_INVALID_FORMAT',
            'Envie JPEG, PNG ou PDF com até 10 MB e no mínimo 800×600.',
            { reason: check },
          ),
        };
      }
      // Um documento novo do mesmo tipo substitui o anterior, que é descartado.
      for (const old of await tx.documents(app.id)) {
        if (old.type === doc.type && old.status === 'ACCEPTED') {
          await tx.saveDocument({ ...old, status: 'PURGED', purgeAt: this.d.clock.now() });
          await this.d.documents.remove(old.storageKey);
        }
      }
      const accepted: DocumentRow = {
        ...doc,
        status: 'ACCEPTED',
        format: check.format,
        sizeBytes: found!.size,
        sha256: found!.sha256,
        width: check.width ?? null,
        height: check.height ?? null,
      };
      await tx.saveDocument(accepted);
      const types = new Set(
        (await tx.documents(app.id)).filter((x) => x.status === 'ACCEPTED').map((x) => x.type),
      );
      if (REQUIRED_DOCUMENTS.every((t) => types.has(t))) await this.complete(tx, app, 'DOCUMENTS');
      else await this.touch(tx, app);
      return { doc: accepted };
    });
    if ('error' in result) throw result.error;
    return { id: result.doc.id, type: result.doc.type, status: result.doc.status };
  }

  /** Suitability e termos concluem as etapas deles (chamado pelos respectivos casos de uso). */
  async completeStep(tx: CustomerTx, userId: string, step: 'SUITABILITY' | 'TERMS'): Promise<void> {
    const app = await tx.applicationOfUser(userId, { forUpdate: true });
    if (!app || !isEditable(app.status)) return;
    // Suitability antes dos documentos não avança o status; vale quando a etapa chegar.
    try {
      await this.complete(tx, app, step);
    } catch (err) {
      if (!(err instanceof CustomerError) || err.code !== 'STEP_OUT_OF_ORDER') throw err;
    }
  }

  // ---------------------------------------------------------------- submissão e KYC (RN-ONB-020..022)

  async submit(userId: string): Promise<{ status: string }> {
    const prepared = await this.d.store.transaction(async (tx) => {
      const app = await this.editable(tx, userId);
      if (app.status !== 'TERMS' && app.status !== 'PENDING_CUSTOMER')
        throw rule(
          'ONBOARDING_INCOMPLETE',
          `Conclua a etapa ${nextStep(app.status)} antes de submeter.`,
        );
      const docs = (await tx.documents(app.id)).filter((x) => x.status === 'ACCEPTED');
      return { app, docs };
    });
    const personal = openJson<PersonalData>(this.d, prepared.app.draft.personalEnc!, CTX.personal);
    const documents = await Promise.all(
      prepared.docs
        .filter((x) => x.type !== 'PROOF_OF_ADDRESS')
        .map(async (x) => ({
          type: x.type as 'ID_FRONT' | 'ID_BACK' | 'SELFIE',
          url: await this.d.documents.downloadUrl(x.storageKey, KYC_URL_TTL_S),
        })),
    );
    // Submete antes de mudar o estado: se o provedor falhar, nada muda e o cliente tenta de novo.
    const { checkId } = await this.d.kyc.submit({
      referenceId: prepared.app.id,
      taxId: personal.taxId,
      fullName: personal.fullName,
      birthDate: personal.birthDate,
      documents,
    });
    return this.d.store.transaction(async (tx) => {
      const app = (await tx.application(prepared.app.id, { forUpdate: true }))!;
      if (app.status !== 'TERMS' && app.status !== 'PENDING_CUSTOMER')
        return { status: app.status };
      app.status = 'UNDER_REVIEW';
      app.kycCheckId = checkId;
      app.submittedAt = this.d.clock.now();
      await this.save(tx, app);
      await tx.publish(
        { type: 'onboarding.submitted', payload: { applicationId: app.id } },
        app.id,
      );
      return { status: app.status };
    });
  }

  /** Webhook `check.verification_completed`: grava a verificação (uma vez por check_id + tipo). */
  async onVerification(
    checkId: string,
    v: { type: string; status: string; score?: number },
    raw: unknown,
  ): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      const app = await tx.applicationByKycCheck(checkId);
      if (!app) return;
      await this.recordCheck(tx, app.id, checkId, v, raw);
    });
  }

  /**
   * Webhook `check.completed`: decide (RN-ONB-010/011/020). Idempotente: a decisão só se aplica
   * com a solicitação em `UNDER_REVIEW` e o `check_id` dela; repetições não fazem nada.
   */
  async onCheckCompleted(
    checkId: string,
    verifications: { type: string; status: string; score?: number }[],
    raw: unknown,
  ): Promise<'DECIDED' | 'IGNORED'> {
    const decided = await this.d.store.transaction(async (tx) => {
      const app = await tx.applicationByKycCheck(checkId, { forUpdate: true });
      if (!app || app.status !== 'UNDER_REVIEW' || app.kycCheckId !== checkId) return null;
      for (const v of verifications) await this.recordCheck(tx, app.id, checkId, v, raw);
      const checks = (await tx.kycChecks(app.id)).filter((c) => c.providerCheckId === checkId);
      const financial = openJson<FinancialProfile>(this.d, app.draft.financialEnc!, CTX.financial);
      const { outcome, reason } = decideKyc(
        checks.map((c) => c.result),
        financial,
      );
      await tx.publish(
        {
          type: 'onboarding.kyc_completed',
          payload: {
            applicationId: app.id,
            outcome,
            checks: checks.map((c) => ({ type: c.checkType, result: c.result })),
          },
        },
        app.id,
      );
      await this.decide(tx, app, outcome, reason, 'kyc-simulator');
      return { outcome, applicationId: app.id };
    });
    if (decided?.outcome === 'APPROVED') await this.startOpening(decided.applicationId);
    return decided ? 'DECIDED' : 'IGNORED';
  }

  // ---------------------------------------------------------------- revisão manual (backoffice)

  async reviewQueue() {
    return this.d.store.transaction(async (tx) =>
      (await tx.reviewQueue(100)).map((a) => ({
        applicationId: a.id,
        status: a.status,
        submittedAt: a.submittedAt?.toString() ?? null,
        reason: a.decisionReason,
      })),
    );
  }

  /**
   * Decisão do backoffice. PEP só com `BO_ADMIN` (Backoffice §3: aprovação de PEP); os demais com
   * `BO_ONBOARDING`. Pedir correção devolve a solicitação ao cliente (`PENDING_CUSTOMER`).
   */
  async review(
    op: Operator,
    applicationId: string,
    decision: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES',
    reason: string,
  ): Promise<{ status: string }> {
    const status = await this.d.store.transaction(async (tx) => {
      const app = await tx.application(applicationId, { forUpdate: true });
      if (!app) throw notFound('Solicitação inexistente.');
      if (app.status !== 'MANUAL_REVIEW')
        throw rule('ONBOARDING_NOT_IN_REVIEW', 'A solicitação não está em revisão manual.');
      const financial = openJson<FinancialProfile>(this.d, app.draft.financialEnc!, CTX.financial);
      if (decision === 'APPROVE' && financial.pep && !op.roles.includes('BO_ADMIN'))
        throw new CustomerError(
          403,
          'PEP_APPROVAL_REQUIRES_ADMIN',
          'Aprovar cliente PEP exige BO_ADMIN.',
        );
      if (decision === 'REQUEST_CHANGES') {
        app.status = 'PENDING_CUSTOMER';
        app.decisionReason = reason;
        app.decidedBy = op.id;
        await this.save(tx, app);
        return app.status;
      }
      await this.decide(tx, app, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', reason, op.id);
      return app.status as string;
    });
    if (status === 'APPROVED') await this.startOpening(applicationId);
    return { status };
  }

  // ---------------------------------------------------------------- expiração (RN-ONB-002)

  /** Rotina diária: 30 dias sem atividade → `EXPIRED`, documentos descartados. */
  async expireIdle(now: Instant): Promise<number> {
    const cutoff = now.plusMillis(-30 * 24 * 3_600_000);
    let expired = 0;
    for (;;) {
      const batch = await this.d.store.transaction(async (tx) => {
        const apps = await tx.applicationsIdleSince(cutoff, 100);
        const keys: string[] = [];
        for (const app of apps) {
          app.status = 'EXPIRED';
          app.decisionReason = 'IDLE_30_DAYS';
          await tx.saveApplication(app);
          for (const doc of await tx.documents(app.id)) {
            if (doc.status === 'PURGED') continue;
            await tx.saveDocument({ ...doc, status: 'PURGED', purgeAt: now });
            keys.push(doc.storageKey);
          }
        }
        return { count: apps.length, keys };
      });
      for (const key of batch.keys) await this.d.documents.remove(key);
      expired += batch.count;
      if (batch.count < 100) return expired;
    }
  }

  // ---------------------------------------------------------------- internos

  private async decide(
    tx: CustomerTx,
    app: ApplicationRow,
    outcome: 'APPROVED' | 'MANUAL_REVIEW' | 'REJECTED',
    reason: string,
    by: string,
  ) {
    app.status = outcome;
    app.decisionReason = reason;
    if (outcome !== 'MANUAL_REVIEW') {
      app.decidedAt = this.d.clock.now();
      app.decidedBy = by;
    }
    await this.save(tx, app);
    if (outcome === 'REJECTED') {
      await tx.publish(
        {
          type: 'onboarding.rejected',
          payload: { applicationId: app.id, reasonCode: reason, decidedBy: by },
        },
        app.id,
      );
    }
    // APPROVED: os eventos de aprovação, cliente e conta saem da saga de abertura.
  }

  private async recordCheck(
    tx: CustomerTx,
    applicationId: string,
    checkId: string,
    v: { type: string; status: string; score?: number },
    raw: unknown,
  ) {
    const type = v.type as KycCheckType;
    await tx.insertKycCheck({
      id: this.d.newId(),
      applicationId,
      providerCheckId: checkId,
      checkType: type,
      result: normalizeCheck(type, v.status, v.score),
      score: v.score ?? null,
      rawPayload: raw,
      receivedAt: this.d.clock.now(),
    });
  }

  /** Solicitação editável do usuário (cria se faltar); expirada ou decidida não aceita etapas. */
  private async editable(tx: CustomerTx, userId: string): Promise<ApplicationRow> {
    const app = await this.ensureStarted(tx, userId);
    if (app.status === 'EXPIRED')
      throw rule(
        'ONBOARDING_EXPIRED',
        'A solicitação expirou por inatividade. Comece de novo com o atendimento.',
      );
    if (!isEditable(app.status)) throw rule('ONBOARDING_LOCKED', 'A solicitação já foi submetida.');
    // A rotina diária pode ainda não ter passado: a expiração vale pelo relógio, não pela rotina.
    if (!this.d.clock.now().isBefore(onboardingExpiresAt(app.lastActivityAt))) {
      throw rule('ONBOARDING_EXPIRED', 'A solicitação expirou por inatividade.');
    }
    return app;
  }

  private requireStepDone(app: ApplicationRow, step: OnboardingStep): void {
    try {
      afterStep(app.status, step);
    } catch {
      throw rule('STEP_OUT_OF_ORDER', `Conclua antes a etapa ${nextStep(app.status)}.`);
    }
  }

  private async complete(tx: CustomerTx, app: ApplicationRow, step: OnboardingStep): Promise<void> {
    try {
      app.status = afterStep(app.status, step);
    } catch {
      throw rule('STEP_OUT_OF_ORDER', `Conclua antes a etapa ${nextStep(app.status)}.`);
    }
    await this.save(tx, app);
    await tx.publish(
      { type: 'onboarding.step_completed', payload: { applicationId: app.id, step } },
      app.id,
    );
  }

  private async touch(tx: CustomerTx, app: ApplicationRow) {
    await this.save(tx, app);
  }

  private async save(tx: CustomerTx, app: ApplicationRow): Promise<void> {
    app.lastActivityAt = this.d.clock.now();
    if ((await tx.saveApplication(app)) === 'TAX_ID_TAKEN') throw taxIdTaken();
  }
}

const taxIdTaken = () =>
  rule('TAX_ID_ALREADY_REGISTERED', 'Esse CPF já tem conta ou solicitação ativa.');
