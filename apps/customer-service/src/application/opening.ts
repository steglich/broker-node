import { accountNumber, REGISTRATION_VALIDITY_MONTHS } from '../domain/account.js';
import { plusMonths } from '../domain/dates.js';
import { CTX, HASH, openJson, sealJson, type CustomerDeps } from './context.js';
import type { Address, FinancialProfile, PersonalData } from './onboarding.js';
import type { AccountRow, CustomerRow } from './ports.js';

/** Dados persistidos da saga (RN-PAD-030): o que cada passo já produziu. */
export interface OpeningData {
  applicationId: string;
  customerId?: string;
  accountId?: string;
  bankAccountId?: string;
}

export const OPENING_SAGA = 'account_opening';

/**
 * Saga de abertura de conta (Mensageria, Fluxos §1): aprovação → cliente e conta `NNNNNNN-D` →
 * eventos → conta no Banco Simulado. Os passos são idempotentes: retomada depois de um reinício
 * repete o passo interrompido sem criar outra conta.
 */
export class AccountOpening {
  constructor(private readonly d: CustomerDeps) {}

  /**
   * Passo 1: cliente, conta e eventos numa transação. Se o cliente da solicitação já existe (passo
   * repetido), devolve o que existe: os eventos já foram para a outbox junto com ele.
   */
  async createCustomerAndAccount(data: OpeningData): Promise<OpeningData> {
    return this.d.store.transaction(async (tx) => {
      const app = await tx.application(data.applicationId, { forUpdate: true });
      if (!app || app.status !== 'APPROVED')
        throw new Error(`solicitação ${data.applicationId} não está aprovada`);
      const existing = await tx.customerOfApplication(app.id);
      if (existing) {
        const account = (await tx.accountOfCustomer(existing.id))!;
        return { ...data, customerId: existing.id, accountId: account.id };
      }
      const now = this.d.clock.now();
      const today = now.businessDate();
      const contact = openJson<{ email: string; phone: string }>(
        this.d,
        app.draft.contactEnc!,
        CTX.contact,
      );
      const p = openJson<PersonalData>(this.d, app.draft.personalEnc!, CTX.personal);
      const address = openJson<Address>(this.d, app.draft.addressEnc!, CTX.address);
      const f = openJson<FinancialProfile>(this.d, app.draft.financialEnc!, CTX.financial);
      const customer: CustomerRow = {
        id: this.d.newId(),
        userId: app.userId,
        applicationId: app.id,
        fullNameEnc: this.d.fields.seal(p.fullName, CTX.fullName),
        socialNameEnc: p.socialName ? this.d.fields.seal(p.socialName, CTX.socialName) : null,
        taxIdEnc: this.d.fields.seal(p.taxId, CTX.taxId),
        taxIdHash: this.d.fields.hash(p.taxId, HASH.taxId),
        birthDateEnc: this.d.fields.seal(p.birthDate, CTX.birthDate),
        nationality: p.nationality,
        maritalStatus: p.maritalStatus,
        motherNameEnc: this.d.fields.seal(p.motherName, CTX.motherName),
        gender: p.gender ?? null,
        emailEnc: this.d.fields.seal(contact.email, CTX.email),
        emailHash: this.d.fields.hash(contact.email, HASH.email),
        phoneEnc: this.d.fields.seal(contact.phone, CTX.phone),
        addressEnc: sealJson(this.d, address, CTX.customerAddress),
        idDocumentEnc: sealJson(this.d, p.idDocument, CTX.idDocument),
        pep: f.pep,
        foreignTaxResidency: f.foreignTaxResidency,
        occupation: f.occupation,
        monthlyIncome: f.monthlyIncome,
        declaredNetWorth: f.declaredNetWorth,
        status: 'ACTIVE',
        registrationValidUntil: plusMonths(today, REGISTRATION_VALIDITY_MONTHS),
        createdAt: now,
      };
      await tx.insertCustomer(customer);
      const account: AccountRow = {
        id: this.d.newId(),
        customerId: customer.id,
        accountNumber: accountNumber(await tx.nextAccountSeq()),
        status: 'ACTIVE',
        restrictions: [],
        marginEnabled: false,
        bankAccountId: null,
        openedAt: now,
        closedAt: null,
      };
      await tx.insertAccount(account);
      app.customerId = customer.id;
      await tx.saveApplication(app);

      const displayName = p.socialName ?? p.fullName.split(/\s+/)[0]!;
      await tx.publish(
        {
          type: 'onboarding.approved',
          payload: {
            applicationId: app.id,
            customerId: customer.id,
            reasonCode: app.decisionReason ?? 'APPROVED',
            decidedBy: app.decidedBy ?? 'system',
          },
        },
        app.id,
      );
      await tx.publish(
        {
          type: 'customer.created',
          payload: {
            customerId: customer.id,
            userId: app.userId,
            displayName,
            declaredNetWorth: f.declaredNetWorth,
            pep: f.pep,
          },
        },
        customer.id,
      );
      await tx.publish(
        {
          type: 'account.opened',
          payload: {
            accountId: account.id,
            customerId: customer.id,
            accountNumber: account.accountNumber,
            openedAt: now.toString(),
          },
        },
        account.id,
      );
      // O perfil do onboarding era do usuário; agora tem cliente e conta para o risco.
      const assessment = await tx.latestAssessment(app.userId);
      if (assessment) {
        await tx.publish(
          {
            type: 'suitability.assessed',
            payload: {
              customerId: customer.id,
              accountId: account.id,
              profile: assessment.profile,
              score: assessment.score,
              validUntil: assessment.validUntil.toString(),
              questionnaireVersion: assessment.questionnaireVersion,
            },
          },
          customer.id,
        );
      }
      return { ...data, customerId: customer.id, accountId: account.id };
    });
  }

  /** Passo 2 (RN-ONB-002 e Sistemas simulados §2.1): conta no Banco Simulado, idempotente pelo CPF. */
  async openBankAccount(data: OpeningData): Promise<OpeningData> {
    const { taxId, name, account } = await this.d.store.transaction(async (tx) => {
      const customer = (await tx.customer(data.customerId!))!;
      return {
        taxId: this.d.fields.open(customer.taxIdEnc, CTX.taxId),
        name: this.d.fields.open(customer.fullNameEnc, CTX.fullName),
        account: (await tx.account(data.accountId!))!,
      };
    });
    if (account.bankAccountId) return { ...data, bankAccountId: account.bankAccountId };
    const { id } = await this.d.bank.openAccount(taxId, name);
    await this.d.store.transaction(async (tx) => {
      const current = (await tx.account(data.accountId!, { forUpdate: true }))!;
      await tx.saveAccount({ ...current, bankAccountId: id });
    });
    return { ...data, bankAccountId: id };
  }
}
