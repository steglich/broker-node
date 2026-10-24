import { AccountOpenedV1 } from '@broker/contracts/events/account.opened/v1';
import { AccountStatusChangedV1 } from '@broker/contracts/events/account.status_changed/v1';
import { CustomerCreatedV1 } from '@broker/contracts/events/customer.created/v1';
import { CustomerUpdatedV1 } from '@broker/contracts/events/customer.updated/v1';
import { OnboardingApprovedV1 } from '@broker/contracts/events/onboarding.approved/v1';
import { OnboardingKycCompletedV1 } from '@broker/contracts/events/onboarding.kyc_completed/v1';
import { OnboardingRejectedV1 } from '@broker/contracts/events/onboarding.rejected/v1';
import { OnboardingStartedV1 } from '@broker/contracts/events/onboarding.started/v1';
import { OnboardingStepCompletedV1 } from '@broker/contracts/events/onboarding.step_completed/v1';
import { OnboardingSubmittedV1 } from '@broker/contracts/events/onboarding.submitted/v1';
import { SuitabilityAssessedV1 } from '@broker/contracts/events/suitability.assessed/v1';
import { SuitabilityExpiredV1 } from '@broker/contracts/events/suitability.expired/v1';
import { SuitabilityExpiringV1 } from '@broker/contracts/events/suitability.expiring/v1';
import { TermsAcceptedV1 } from '@broker/contracts/events/terms.accepted/v1';
import { BusinessDate, Instant } from '@broker/domain-kernel';
import type { EventDefinition, EventPublisher } from '@broker/messaging';
import { inTransaction } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type {
  AccountRow,
  ApplicationRow,
  AssessmentRow,
  CustomerRow,
  CustomerStore,
  CustomerTx,
  DocumentRow,
  KycCheckRow,
  ProfileChangeRow,
  TermsRow,
  WithdrawalAccountRow,
} from '../application/ports.js';
import type { Restriction } from '../domain/account.js';

type Row = Record<string, unknown>;

const inst = (v: unknown): Instant => Instant.ofEpochMillis((v as Date).getTime());
const instOrNull = (v: unknown): Instant | null => (v ? inst(v) : null);
const ts = (i: Instant | null | undefined) => (i ? i.toString() : null);
const str = (v: unknown) => (v as string | null) ?? null;
const lock = (opts?: { forUpdate?: boolean }) => (opts?.forUpdate ? sql` FOR UPDATE` : sql``);
const ACTIVE_APPS = sql`status NOT IN ('APPROVED', 'REJECTED', 'EXPIRED')`;

const toApplication = (r: Row): ApplicationRow => ({
  id: r['id'] as string,
  userId: r['user_id'] as string,
  status: r['status'] as ApplicationRow['status'],
  draft: r['draft'] as ApplicationRow['draft'],
  taxIdHash: str(r['tax_id_hash']),
  emailHash: str(r['email_hash']),
  contactOtp: (r['contact_otp'] as ApplicationRow['contactOtp']) ?? null,
  kycCheckId: str(r['kyc_check_id']),
  customerId: str(r['customer_id']),
  createdAt: inst(r['created_at']),
  lastActivityAt: inst(r['last_activity_at']),
  submittedAt: instOrNull(r['submitted_at']),
  decidedAt: instOrNull(r['decided_at']),
  decidedBy: str(r['decided_by']),
  decisionReason: str(r['decision_reason']),
});

const toDocument = (r: Row): DocumentRow => ({
  id: r['id'] as string,
  applicationId: r['application_id'] as string,
  type: r['type'] as DocumentRow['type'],
  storageKey: r['storage_key'] as string,
  declaredContentType: r['declared_content_type'] as string,
  declaredSize: Number(r['declared_size']),
  format: str(r['format']),
  sizeBytes: r['size_bytes'] === null ? null : Number(r['size_bytes']),
  sha256: str(r['sha256']),
  width: (r['width'] as number | null) ?? null,
  height: (r['height'] as number | null) ?? null,
  status: r['status'] as DocumentRow['status'],
  rejectReason: str(r['reject_reason']),
  createdAt: inst(r['created_at']),
  purgeAt: instOrNull(r['purge_at']),
});

const toCustomer = (r: Row): CustomerRow => ({
  id: r['id'] as string,
  userId: r['user_id'] as string,
  applicationId: r['application_id'] as string,
  fullNameEnc: r['full_name_enc'] as string,
  socialNameEnc: str(r['social_name_enc']),
  taxIdEnc: r['tax_id_enc'] as string,
  taxIdHash: r['tax_id_hash'] as string,
  birthDateEnc: r['birth_date_enc'] as string,
  nationality: r['nationality'] as string,
  maritalStatus: r['marital_status'] as string,
  motherNameEnc: r['mother_name_enc'] as string,
  gender: str(r['gender']),
  emailEnc: r['email_enc'] as string,
  emailHash: r['email_hash'] as string,
  phoneEnc: r['phone_enc'] as string,
  addressEnc: r['address_enc'] as string,
  idDocumentEnc: r['id_document_enc'] as string,
  pep: r['pep'] as boolean,
  foreignTaxResidency: r['foreign_tax_residency'] as boolean,
  occupation: r['occupation'] as string,
  monthlyIncome: String(r['monthly_income']),
  declaredNetWorth: String(r['declared_net_worth']),
  status: r['status'] as CustomerRow['status'],
  registrationValidUntil: BusinessDate.parse(r['registration_valid_until_text'] as string),
  createdAt: inst(r['created_at']),
});
const CUSTOMER_COLS = sql`*, registration_valid_until::text AS registration_valid_until_text`;

const toAccount = (r: Row): AccountRow => ({
  id: r['id'] as string,
  customerId: r['customer_id'] as string,
  accountNumber: r['account_number'] as string,
  status: r['status'] as AccountRow['status'],
  restrictions: r['restrictions'] as Restriction[],
  marginEnabled: r['margin_enabled'] as boolean,
  bankAccountId: str(r['bank_account_id']),
  openedAt: inst(r['opened_at']),
  closedAt: instOrNull(r['closed_at']),
});

const toAssessment = (r: Row): AssessmentRow => ({
  id: r['id'] as string,
  userId: r['user_id'] as string,
  questionnaireId: r['questionnaire_id'] as string,
  questionnaireVersion: Number(r['version']),
  answers: r['answers'] as Record<string, string>,
  score: Number(r['score']),
  profile: r['profile'] as AssessmentRow['profile'],
  assessedAt: inst(r['assessed_at']),
  validUntil: BusinessDate.parse(r['valid_until_text'] as string),
  expiringNotified: r['expiring_notified'] as boolean,
  expiredNotified: r['expired_notified'] as boolean,
});
const ASSESSMENT_COLS = sql`a.*, a.valid_until::text AS valid_until_text, q.version`;

const toTerms = (r: Row): TermsRow => ({
  id: r['id'] as string,
  code: r['code'] as string,
  version: Number(r['version']),
  title: r['title'] as string,
  content: r['content'] as string,
  contentHash: r['content_hash'] as string,
  mandatory: r['mandatory'] as boolean,
  moment: r['moment'] as TermsRow['moment'],
  validFrom: inst(r['valid_from']),
});

const toWithdrawal = (r: Row): WithdrawalAccountRow => ({
  id: r['id'] as string,
  accountId: r['account_id'] as string,
  pixKeyEnc: r['pix_key_enc'] as string,
  pixKeyHash: r['pix_key_hash'] as string,
  pixKeyType: r['pix_key_type'] as string,
  holderNameMasked: r['holder_name_masked'] as string,
  status: r['status'] as WithdrawalAccountRow['status'],
  availableFrom: inst(r['available_from']),
  createdAt: inst(r['created_at']),
});

const toChange = (r: Row): ProfileChangeRow => ({
  id: r['id'] as string,
  customerId: r['customer_id'] as string,
  kind: r['kind'] as ProfileChangeRow['kind'],
  newValueEnc: r['new_value_enc'] as string,
  documentKey: str(r['document_key']),
  otpOldHash: str(r['otp_old_hash']),
  otpNewHash: str(r['otp_new_hash']),
  attempts: Number(r['attempts']),
  status: r['status'] as ProfileChangeRow['status'],
  createdAt: inst(r['created_at']),
  expiresAt: instOrNull(r['expires_at']),
  decidedBy: str(r['decided_by']),
});

const EVENTS: Record<string, EventDefinition> = {
  'onboarding.started': OnboardingStartedV1,
  'onboarding.step_completed': OnboardingStepCompletedV1,
  'onboarding.submitted': OnboardingSubmittedV1,
  'onboarding.kyc_completed': OnboardingKycCompletedV1,
  'onboarding.approved': OnboardingApprovedV1,
  'onboarding.rejected': OnboardingRejectedV1,
  'customer.created': CustomerCreatedV1,
  'customer.updated': CustomerUpdatedV1,
  'account.opened': AccountOpenedV1,
  'account.status_changed': AccountStatusChangedV1,
  'suitability.assessed': SuitabilityAssessedV1,
  'suitability.expiring': SuitabilityExpiringV1,
  'suitability.expired': SuitabilityExpiredV1,
  'terms.accepted': TermsAcceptedV1,
};

const ACTOR = { type: 'SYSTEM' as const, id: 'customer-service' };

const isUniqueViolation = (err: unknown, constraint: string) =>
  (err as { code?: string; constraint?: string }).code === '23505' &&
  (err as { constraint?: string }).constraint === constraint;

/** Adaptador do banco do customer-service; eventos pela outbox na mesma transação (ADR-0008). */
export class PostgresCustomerStore implements CustomerStore {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly publisher: EventPublisher,
  ) {}

  transaction<T>(fn: (tx: CustomerTx) => Promise<T>): Promise<T> {
    return inTransaction(this.db, (trx) => fn(this.tx(trx)));
  }

  tx(trx: Kysely<unknown>): CustomerTx {
    const publisher = this.publisher;
    const one = async (q: ReturnType<typeof sql<Row>>) => (await q.execute(trx)).rows[0];
    const all = async (q: ReturnType<typeof sql<Row>>) => (await q.execute(trx)).rows;
    return {
      // ------------------------------------------------------------ onboarding
      async application(id, opts) {
        const r = await one(
          sql<Row>`SELECT * FROM onboarding_application WHERE id = ${id}${lock(opts)}`,
        );
        return r ? toApplication(r) : null;
      },
      async applicationOfUser(userId, opts) {
        const r = await one(
          sql<Row>`SELECT * FROM onboarding_application WHERE user_id = ${userId}${lock(opts)}`,
        );
        return r ? toApplication(r) : null;
      },
      async applicationByKycCheck(checkId, opts) {
        const r = await one(
          sql<Row>`SELECT * FROM onboarding_application WHERE kyc_check_id = ${checkId}${lock(opts)}`,
        );
        return r ? toApplication(r) : null;
      },
      async insertApplication(a) {
        const { rows } = await sql`
          INSERT INTO onboarding_application (id, user_id, status, draft, created_at, last_activity_at)
          VALUES (${a.id}, ${a.userId}, ${a.status}, ${JSON.stringify(a.draft)}::jsonb, ${a.createdAt.toString()}, ${a.lastActivityAt.toString()})
          ON CONFLICT (user_id) DO NOTHING RETURNING id`.execute(trx);
        return rows.length > 0;
      },
      async saveApplication(a) {
        try {
          // Savepoint: a violação de unicidade do CPF não pode abortar a transação inteira.
          await sql`SAVEPOINT save_application`.execute(trx);
          await sql`
            UPDATE onboarding_application SET status = ${a.status}, draft = ${JSON.stringify(a.draft)}::jsonb,
              tax_id_hash = ${a.taxIdHash}, email_hash = ${a.emailHash},
              contact_otp = ${a.contactOtp ? JSON.stringify(a.contactOtp) : null}::jsonb, kyc_check_id = ${a.kycCheckId},
              customer_id = ${a.customerId}, last_activity_at = ${a.lastActivityAt.toString()},
              submitted_at = ${ts(a.submittedAt)}, decided_at = ${ts(a.decidedAt)}, decided_by = ${a.decidedBy},
              decision_reason = ${a.decisionReason}, version = version + 1
            WHERE id = ${a.id}`.execute(trx);
          await sql`RELEASE SAVEPOINT save_application`.execute(trx);
          return 'OK';
        } catch (err) {
          await sql`ROLLBACK TO SAVEPOINT save_application`.execute(trx);
          if (isUniqueViolation(err, 'onboarding_active_tax_id')) return 'TAX_ID_TAKEN';
          throw err;
        }
      },
      async applicationsIdleSince(before, limit) {
        return (
          await all(sql<Row>`
            SELECT * FROM onboarding_application
            WHERE status NOT IN ('UNDER_REVIEW', 'MANUAL_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED')
              AND last_activity_at < ${before.toString()}
            ORDER BY last_activity_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`)
        ).map(toApplication);
      },
      async reviewQueue(limit) {
        return (
          await all(
            sql<Row>`SELECT * FROM onboarding_application WHERE status = 'MANUAL_REVIEW' ORDER BY submitted_at LIMIT ${limit}`,
          )
        ).map(toApplication);
      },

      async documents(applicationId) {
        return (
          await all(
            sql<Row>`SELECT * FROM customer_document WHERE application_id = ${applicationId} ORDER BY created_at`,
          )
        ).map(toDocument);
      },
      async document(id, opts) {
        const r = await one(
          sql<Row>`SELECT * FROM customer_document WHERE id = ${id}${lock(opts)}`,
        );
        return r ? toDocument(r) : null;
      },
      async insertDocument(d) {
        await sql`
          INSERT INTO customer_document (id, application_id, type, storage_key, declared_content_type, declared_size, status, created_at)
          VALUES (${d.id}, ${d.applicationId}, ${d.type}, ${d.storageKey}, ${d.declaredContentType}, ${d.declaredSize}, ${d.status}, ${d.createdAt.toString()})`.execute(
          trx,
        );
      },
      async saveDocument(d) {
        await sql`
          UPDATE customer_document SET format = ${d.format}, size_bytes = ${d.sizeBytes}, sha256 = ${d.sha256}, width = ${d.width},
            height = ${d.height}, status = ${d.status}, reject_reason = ${d.rejectReason}, purge_at = ${ts(d.purgeAt)}
          WHERE id = ${d.id}`.execute(trx);
      },

      async insertKycCheck(c: KycCheckRow) {
        const { rows } = await sql`
          INSERT INTO kyc_check (id, application_id, provider_check_id, check_type, result, score, raw_payload, received_at)
          VALUES (${c.id}, ${c.applicationId}, ${c.providerCheckId}, ${c.checkType}, ${c.result}, ${c.score},
            ${JSON.stringify(c.rawPayload)}::jsonb, ${c.receivedAt.toString()})
          ON CONFLICT (provider_check_id, check_type) DO NOTHING RETURNING id`.execute(trx);
        return rows.length > 0;
      },
      async kycChecks(applicationId) {
        return (
          await all(
            sql<Row>`SELECT * FROM kyc_check WHERE application_id = ${applicationId} ORDER BY received_at`,
          )
        ).map((r) => ({
          id: r['id'] as string,
          applicationId,
          providerCheckId: r['provider_check_id'] as string,
          checkType: r['check_type'] as KycCheckRow['checkType'],
          result: r['result'] as KycCheckRow['result'],
          score: (r['score'] as number | null) ?? null,
          rawPayload: r['raw_payload'],
          receivedAt: inst(r['received_at']),
        }));
      },

      // ------------------------------------------------------------ cliente e conta
      async customer(id) {
        const r = await one(sql<Row>`SELECT ${CUSTOMER_COLS} FROM customer WHERE id = ${id}`);
        return r ? toCustomer(r) : null;
      },
      async customerOfUser(userId) {
        const r = await one(
          sql<Row>`SELECT ${CUSTOMER_COLS} FROM customer WHERE user_id = ${userId}`,
        );
        return r ? toCustomer(r) : null;
      },
      async customerOfApplication(applicationId) {
        const r = await one(
          sql<Row>`SELECT ${CUSTOMER_COLS} FROM customer WHERE application_id = ${applicationId}`,
        );
        return r ? toCustomer(r) : null;
      },
      async openCustomerWithTaxId(taxIdHash) {
        return !!(await one(
          sql<Row>`SELECT 1 FROM customer WHERE tax_id_hash = ${taxIdHash} AND status <> 'CLOSED'`,
        ));
      },
      async emailInUse(emailHash, exceptUserId) {
        return !!(await one(sql<Row>`
          SELECT 1 FROM customer WHERE email_hash = ${emailHash} AND status <> 'CLOSED' AND user_id <> ${exceptUserId}
          UNION ALL
          SELECT 1 FROM onboarding_application WHERE email_hash = ${emailHash} AND ${ACTIVE_APPS} AND user_id <> ${exceptUserId}
          LIMIT 1`));
      },
      async insertCustomer(c) {
        await sql`
          INSERT INTO customer (id, user_id, application_id, full_name_enc, social_name_enc, tax_id_enc, tax_id_hash,
            birth_date_enc, nationality, marital_status, mother_name_enc, gender, email_enc, email_hash, phone_enc,
            address_enc, id_document_enc, pep, foreign_tax_residency, occupation, monthly_income, declared_net_worth,
            status, registration_valid_until, created_at)
          VALUES (${c.id}, ${c.userId}, ${c.applicationId}, ${c.fullNameEnc}, ${c.socialNameEnc}, ${c.taxIdEnc}, ${c.taxIdHash},
            ${c.birthDateEnc}, ${c.nationality}, ${c.maritalStatus}, ${c.motherNameEnc}, ${c.gender}, ${c.emailEnc},
            ${c.emailHash}, ${c.phoneEnc}, ${c.addressEnc}, ${c.idDocumentEnc}, ${c.pep}, ${c.foreignTaxResidency},
            ${c.occupation}, ${c.monthlyIncome}, ${c.declaredNetWorth}, ${c.status}, ${c.registrationValidUntil.toString()},
            ${c.createdAt.toString()})`.execute(trx);
      },
      async updateCustomer(id, p) {
        const sets = [];
        if (p.fullNameEnc !== undefined) sets.push(sql`full_name_enc = ${p.fullNameEnc}`);
        if (p.emailEnc !== undefined) sets.push(sql`email_enc = ${p.emailEnc}`);
        if (p.emailHash !== undefined) sets.push(sql`email_hash = ${p.emailHash}`);
        if (p.phoneEnc !== undefined) sets.push(sql`phone_enc = ${p.phoneEnc}`);
        if (p.addressEnc !== undefined) sets.push(sql`address_enc = ${p.addressEnc}`);
        if (p.idDocumentEnc !== undefined) sets.push(sql`id_document_enc = ${p.idDocumentEnc}`);
        if (p.registrationValidUntil !== undefined)
          sets.push(sql`registration_valid_until = ${p.registrationValidUntil.toString()}`);
        if (p.status !== undefined) sets.push(sql`status = ${p.status}`);
        if (sets.length > 0)
          await sql`UPDATE customer SET ${sql.join(sets)} WHERE id = ${id}`.execute(trx);
      },
      async customersWithRegistrationBefore(date, limit) {
        return (
          await all(sql<Row>`
            SELECT ${CUSTOMER_COLS} FROM customer WHERE status = 'ACTIVE' AND registration_valid_until < ${date.toString()}
            ORDER BY registration_valid_until LIMIT ${limit}`)
        ).map(toCustomer);
      },

      async nextAccountSeq() {
        return Number((await one(sql<Row>`SELECT nextval('account_number_seq') AS n`))!['n']);
      },
      async account(id, opts) {
        const r = await one(
          sql<Row>`SELECT * FROM investment_account WHERE id = ${id}${lock(opts)}`,
        );
        return r ? toAccount(r) : null;
      },
      async accountOfCustomer(customerId, opts) {
        const r = await one(sql<Row>`
          SELECT * FROM investment_account WHERE customer_id = ${customerId} ORDER BY opened_at DESC LIMIT 1${lock(opts)}`);
        return r ? toAccount(r) : null;
      },
      async insertAccount(a) {
        await sql`
          INSERT INTO investment_account (id, customer_id, account_number, status, restrictions, margin_enabled, bank_account_id, opened_at)
          VALUES (${a.id}, ${a.customerId}, ${a.accountNumber}, ${a.status}, ${a.restrictions}, ${a.marginEnabled}, ${a.bankAccountId},
            ${a.openedAt.toString()})`.execute(trx);
      },
      async saveAccount(a) {
        await sql`
          UPDATE investment_account SET status = ${a.status}, restrictions = ${a.restrictions}, margin_enabled = ${a.marginEnabled},
            bank_account_id = ${a.bankAccountId}, closed_at = ${ts(a.closedAt)}, version = version + 1
          WHERE id = ${a.id}`.execute(trx);
      },

      // ------------------------------------------------------------ suitability e termos
      async currentQuestionnaire() {
        const r = (await one(
          sql<Row>`SELECT * FROM suitability_questionnaire WHERE valid_to IS NULL ORDER BY version DESC LIMIT 1`,
        ))!;
        return {
          id: r['id'] as string,
          version: Number(r['version']),
          questions: r['questions'] as never,
          bands: (r['scoring'] as { bands: never }).bands,
        };
      },
      async insertAssessment(a) {
        await sql`
          INSERT INTO suitability_assessment (id, user_id, questionnaire_id, answers, score, profile, assessed_at, valid_until)
          VALUES (${a.id}, ${a.userId}, ${a.questionnaireId}, ${JSON.stringify(a.answers)}::jsonb, ${a.score}, ${a.profile},
            ${a.assessedAt.toString()}, ${a.validUntil.toString()})`.execute(trx);
      },
      async latestAssessment(userId) {
        const r = await one(sql<Row>`
          SELECT ${ASSESSMENT_COLS} FROM suitability_assessment a JOIN suitability_questionnaire q ON q.id = a.questionnaire_id
          WHERE a.user_id = ${userId} ORDER BY a.assessed_at DESC, a.id DESC LIMIT 1`);
        return r ? toAssessment(r) : null;
      },
      async assessmentsToNotify(kind, until, limit) {
        const flag = kind === 'EXPIRING' ? sql`a.expiring_notified` : sql`a.expired_notified`;
        const cmp =
          kind === 'EXPIRING'
            ? sql`a.valid_until <= ${until.toString()}`
            : sql`a.valid_until <= ${until.toString()}`;
        // Só a avaliação mais recente de cada usuário importa (RN-SUI-013).
        return (
          await all(sql<Row>`
            SELECT ${ASSESSMENT_COLS} FROM suitability_assessment a JOIN suitability_questionnaire q ON q.id = a.questionnaire_id
            WHERE NOT ${flag} AND ${cmp}
              AND a.id = (SELECT b.id FROM suitability_assessment b WHERE b.user_id = a.user_id ORDER BY b.assessed_at DESC, b.id DESC LIMIT 1)
            ORDER BY a.valid_until LIMIT ${limit} FOR UPDATE OF a SKIP LOCKED`)
        ).map(toAssessment);
      },
      async markAssessmentNotified(id, kind) {
        if (kind === 'EXPIRING')
          await sql`UPDATE suitability_assessment SET expiring_notified = true WHERE id = ${id}`.execute(
            trx,
          );
        else
          await sql`UPDATE suitability_assessment SET expired_notified = true, expiring_notified = true WHERE id = ${id}`.execute(
            trx,
          );
      },

      async currentTerms() {
        return (
          await all(sql<Row>`
            SELECT DISTINCT ON (code) * FROM terms_document ORDER BY code, version DESC`)
        ).map(toTerms);
      },
      async terms(id) {
        const r = await one(sql<Row>`SELECT * FROM terms_document WHERE id = ${id}`);
        return r ? toTerms(r) : null;
      },
      async latestTermsVersion(code) {
        const r = await one(
          sql<Row>`SELECT * FROM terms_document WHERE code = ${code} ORDER BY version DESC LIMIT 1`,
        );
        return r ? toTerms(r) : null;
      },
      async insertTerms(t) {
        await sql`
          INSERT INTO terms_document (id, code, version, title, content, content_hash, mandatory, moment, valid_from)
          VALUES (${t.id}, ${t.code}, ${t.version}, ${t.title}, ${t.content}, ${t.contentHash}, ${t.mandatory}, ${t.moment}, ${t.validFrom.toString()})`.execute(
          trx,
        );
      },
      async acceptedTermsIds(userId) {
        return new Set(
          (
            await all(sql<Row>`SELECT terms_id FROM terms_acceptance WHERE user_id = ${userId}`)
          ).map((r) => r['terms_id'] as string),
        );
      },
      async insertAcceptance(a) {
        const { rows } = await sql`
          INSERT INTO terms_acceptance (id, user_id, terms_id, accepted_at, ip, user_agent, channel, content_hash)
          VALUES (${a.id}, ${a.userId}, ${a.termsId}, ${a.acceptedAt.toString()}, ${a.ip}, ${a.userAgent}, ${a.channel}, ${a.contentHash})
          ON CONFLICT (user_id, terms_id) DO NOTHING RETURNING id`.execute(trx);
        return rows.length > 0;
      },

      // ------------------------------------------------------------ contas de saque e cadastro
      async withdrawalAccounts(accountId) {
        return (
          await all(
            sql<Row>`SELECT * FROM withdrawal_bank_account WHERE account_id = ${accountId} AND status = 'ACTIVE' ORDER BY created_at`,
          )
        ).map(toWithdrawal);
      },
      async withdrawalAccount(id) {
        const r = await one(sql<Row>`SELECT * FROM withdrawal_bank_account WHERE id = ${id}`);
        return r ? toWithdrawal(r) : null;
      },
      async insertWithdrawalAccount(w) {
        try {
          await sql`SAVEPOINT insert_withdrawal`.execute(trx);
          await sql`
            INSERT INTO withdrawal_bank_account (id, account_id, pix_key_enc, pix_key_hash, pix_key_type, holder_name_masked, status,
              available_from, created_at)
            VALUES (${w.id}, ${w.accountId}, ${w.pixKeyEnc}, ${w.pixKeyHash}, ${w.pixKeyType}, ${w.holderNameMasked}, ${w.status},
              ${w.availableFrom.toString()}, ${w.createdAt.toString()})`.execute(trx);
          await sql`RELEASE SAVEPOINT insert_withdrawal`.execute(trx);
          return 'OK';
        } catch (err) {
          await sql`ROLLBACK TO SAVEPOINT insert_withdrawal`.execute(trx);
          if (isUniqueViolation(err, 'withdrawal_account_key')) return 'DUPLICATE';
          throw err;
        }
      },
      async removeWithdrawalAccount(id) {
        await sql`UPDATE withdrawal_bank_account SET status = 'REMOVED' WHERE id = ${id}`.execute(
          trx,
        );
      },
      async profileChange(id, opts) {
        const r = await one(sql<Row>`SELECT * FROM profile_change WHERE id = ${id}${lock(opts)}`);
        return r ? toChange(r) : null;
      },
      async insertProfileChange(c) {
        await sql`
          INSERT INTO profile_change (id, customer_id, kind, new_value_enc, document_key, otp_old_hash, otp_new_hash, attempts, status,
            created_at, expires_at)
          VALUES (${c.id}, ${c.customerId}, ${c.kind}, ${c.newValueEnc}, ${c.documentKey}, ${c.otpOldHash}, ${c.otpNewHash}, ${c.attempts},
            ${c.status}, ${c.createdAt.toString()}, ${ts(c.expiresAt)})`.execute(trx);
      },
      async saveProfileChange(c) {
        await sql`
          UPDATE profile_change SET attempts = ${c.attempts}, status = ${c.status}, decided_by = ${c.decidedBy} WHERE id = ${c.id}`.execute(
          trx,
        );
      },
      async pendingReviews(limit) {
        return (
          await all(
            sql<Row>`SELECT * FROM profile_change WHERE status = 'PENDING_REVIEW' ORDER BY created_at LIMIT ${limit}`,
          )
        ).map(toChange);
      },
      async insertHistory(h) {
        await sql`
          INSERT INTO customer_change_history (id, customer_id, field, old_value_enc, new_value_enc, actor_id, at)
          VALUES (${h.id}, ${h.customerId}, ${h.field}, ${h.oldValueEnc}, ${h.newValueEnc}, ${h.actorId}, ${h.at.toString()})`.execute(
          trx,
        );
      },
      async history(customerId) {
        return (
          await all(
            sql<Row>`SELECT field, actor_id, at FROM customer_change_history WHERE customer_id = ${customerId} ORDER BY at`,
          )
        ).map((r) => ({
          field: r['field'] as string,
          actorId: r['actor_id'] as string,
          at: inst(r['at']),
        }));
      },

      async publish(event, partitionKey) {
        const definition = EVENTS[event.type];
        if (!definition) throw new Error(`evento sem contrato: ${event.type}`);
        await publisher.publish(trx, definition, event.payload as never, {
          partitionKey,
          aggregateType: event.type.split('.')[0]!,
          aggregateId: partitionKey,
          actor: ACTOR,
        });
      },
    };
  }

  /** Solicitações aprovadas sem cliente e sem saga em andamento: abertura a retomar (RN-PAD-030). */
  async approvedWithoutOpening(): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      SELECT a.id FROM onboarding_application a
      WHERE a.status = 'APPROVED' AND a.customer_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM saga_instance s
          WHERE s.saga_type = 'account_opening' AND s.data->>'applicationId' = a.id::text
            AND s.state IN ('RUNNING', 'COMPENSATING', 'COMPLETED'))
      ORDER BY a.decided_at`.execute(this.db);
    return rows.map((r) => r.id);
  }
}
