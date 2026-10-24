import type { BusinessDate } from '@broker/domain-kernel';
import {
  canTransition,
  MAX_WITHDRAWAL_ACCOUNTS,
  permissions,
  REGISTRATION_VALIDITY_MONTHS,
  statusFor,
  WITHDRAWAL_ACCOUNT_GRACE_MS,
  type AccountStatus,
  type ClosurePendency,
  type Operation,
  type Restriction,
} from '../domain/account.js';
import { plusMonths } from '../domain/dates.js';
import { isCep, isE164, isUf, validateName } from '../domain/onboarding.js';
import {
  CTX,
  CustomerError,
  HASH,
  invalid,
  notFound,
  openJson,
  rule,
  sealJson,
  type Caller,
  type CustomerDeps,
  type Operator,
} from './context.js';
import type { Address } from './onboarding.js';
import type { AccountRow, ChangeKind, CustomerRow, CustomerTx } from './ports.js';
import { termsPendingError, type SuitabilityAndTerms } from './suitability-terms.js';

const CHANGE_OTP_TTL_MS = 10 * 60_000;
const CHANGE_OTP_ATTEMPTS = 5;
const CLOSURE_SOURCES: readonly ClosurePendency['source'][] = [
  'LEDGER',
  'CUSTODY',
  'SECURITIES_LENDING',
  'CLEARING',
  'TAX',
];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Actor = { type: 'USER' | 'BACKOFFICE' | 'SYSTEM'; id: string };

/**
 * Conta de investimento (Contas §7–§8): status e matriz de permissões, restrições por saldo devedor
 * e cadastro vencido, bloqueio, encerramento, contas de saque e manutenção cadastral.
 */
export class Accounts {
  constructor(
    private readonly d: CustomerDeps,
    private readonly terms: SuitabilityAndTerms,
  ) {}

  // ---------------------------------------------------------------- status (RN-ACC-010/011)

  /** Muda o status e publica `account.status_changed` com motivo e ator (RN-ACC-010). */
  private async setStatus(
    tx: CustomerTx,
    account: AccountRow,
    to: AccountStatus,
    reasonCode: string,
    actor: Actor,
  ): Promise<void> {
    const from = account.status;
    if (from === to) {
      await tx.saveAccount(account);
      return;
    }
    account.status = to;
    if (to === 'CLOSED') account.closedAt = this.d.clock.now();
    await tx.saveAccount(account);
    await tx.publish(
      {
        type: 'account.status_changed',
        payload: {
          accountId: account.id,
          from,
          to,
          reasonCode,
          restrictions: account.restrictions,
          actor,
        },
      },
      account.id,
    );
  }

  /**
   * Liga ou desliga uma restrição: com alguma, `ACTIVE` vira `RESTRICTED`; sem nenhuma, volta a
   * `ACTIVE` (RN-DEV-002/005, RN-CAD-003). Bloqueio e encerramento não mudam por restrição.
   */
  async setRestriction(
    tx: CustomerTx,
    accountId: string,
    restriction: Restriction,
    on: boolean,
    actor: Actor,
  ): Promise<AccountStatus | null> {
    const account = await tx.account(accountId, { forUpdate: true });
    if (!account) return null;
    const has = account.restrictions.includes(restriction);
    if (has === on) return account.status;
    account.restrictions = on
      ? [...account.restrictions, restriction].sort()
      : account.restrictions.filter((r) => r !== restriction);
    await this.setStatus(
      tx,
      account,
      statusFor(account.status, account.restrictions),
      on ? restriction : `${restriction}_CLEARED`,
      actor,
    );
    return account.status;
  }

  /** Bloqueio total (BO_RISK, BO_FINANCE, BO_ADMIN): o OMS cancela as ordens ao ver o evento (RN-ACC-011). */
  async block(
    op: Operator,
    accountId: string,
    reasonCode: string,
  ): Promise<{ status: AccountStatus }> {
    return this.d.store.transaction(async (tx) => {
      const account = await tx.account(accountId, { forUpdate: true });
      if (!account) throw notFound('Conta inexistente.');
      if (!canTransition(account.status, 'BLOCKED'))
        throw rule('INVALID_ACCOUNT_TRANSITION', `Conta ${account.status} não pode ser bloqueada.`);
      await this.setStatus(tx, account, 'BLOCKED', reasonCode, { type: 'BACKOFFICE', id: op.id });
      return { status: account.status };
    });
  }

  /** Desbloqueio: volta a `ACTIVE` ou a `RESTRICTED` se houver restrição pendente. */
  async unblock(
    op: Operator,
    accountId: string,
    reasonCode: string,
  ): Promise<{ status: AccountStatus }> {
    return this.d.store.transaction(async (tx) => {
      const account = await tx.account(accountId, { forUpdate: true });
      if (!account) throw notFound('Conta inexistente.');
      if (account.status !== 'BLOCKED')
        throw rule('INVALID_ACCOUNT_TRANSITION', 'A conta não está bloqueada.');
      await this.setStatus(tx, account, statusFor('ACTIVE', account.restrictions), reasonCode, {
        type: 'BACKOFFICE',
        id: op.id,
      });
      return { status: account.status };
    });
  }

  /**
   * Elegibilidade de uma operação (para o OMS, o ledger e os BFFs): matriz de permissões,
   * termos obrigatórios pendentes (só consulta, RN-TER-001) e suitability vencido para compra.
   */
  async eligibility(
    accountId: string,
    operation: Operation,
  ): Promise<{
    allowed: boolean;
    code?: string;
    status: AccountStatus;
    restrictions: Restriction[];
  }> {
    return this.d.store.transaction(async (tx) => {
      const account = await tx.account(accountId);
      if (!account) throw notFound('Conta inexistente.');
      const customer = (await tx.customer(account.customerId))!;
      const base = { status: account.status, restrictions: account.restrictions };
      if (!permissions(account.status, account.restrictions)[operation])
        return { allowed: false, code: 'ACCOUNT_NOT_ACTIVE', ...base };
      if (
        operation !== 'LOGIN' &&
        (await this.terms.pendingMandatory(tx, customer.userId)).length > 0
      )
        return { allowed: false, code: 'TERMS_PENDING', ...base };
      if (operation === 'BUY') {
        const a = await tx.latestAssessment(customer.userId);
        if (!a || this.d.clock.now().businessDate().epochDay >= a.validUntil.epochDay)
          return { allowed: false, code: 'SUITABILITY_EXPIRED', ...base };
      }
      return { allowed: true, ...base };
    });
  }

  /** Para os casos de uso que querem lançar o erro em vez de receber a resposta. */
  async assertEligible(accountId: string, operation: Operation): Promise<void> {
    const r = await this.eligibility(accountId, operation);
    if (r.allowed) return;
    if (r.code === 'TERMS_PENDING') throw termsPendingError([]);
    throw rule(
      r.code!,
      r.code === 'ACCOUNT_NOT_ACTIVE'
        ? `A conta ${r.status} não permite ${operation}.`
        : 'Refaça o questionário de suitability.',
    );
  }

  // ---------------------------------------------------------------- encerramento (RN-ACC-012)

  /**
   * Pede o encerramento: consulta as pendências em cada dono (ledger, custódia, aluguel,
   * liquidação, IR). Com pendência, responde a lista e a conta continua como está; sem nenhuma,
   * `CLOSING` → `CLOSED`.
   */
  async requestClosure(caller: Caller): Promise<{ status: AccountStatus }> {
    const account = await this.callerAccount(caller);
    if (account.status !== 'ACTIVE' && account.status !== 'CLOSING')
      throw rule('ACCOUNT_NOT_ACTIVE', `Conta ${account.status} não pode ser encerrada agora.`);
    const pendencies = await this.closurePendencies(account.id);
    if (pendencies.length > 0) {
      throw rule('ACCOUNT_CLOSURE_PENDING', 'Resolva as pendências antes de encerrar a conta.', {
        pendencies,
      });
    }
    return this.d.store.transaction(async (tx) => {
      const current = (await tx.account(account.id, { forUpdate: true }))!;
      const actor: Actor = { type: 'USER', id: caller.userId };
      if (current.status === 'ACTIVE')
        await this.setStatus(tx, current, 'CLOSING', 'CUSTOMER_REQUEST', actor);
      await this.setStatus(tx, current, 'CLOSED', 'NO_PENDENCIES', actor);
      await tx.updateCustomer(current.customerId, { status: 'CLOSED' });
      return { status: current.status };
    });
  }

  /** O cliente desiste: `CLOSING` → `ACTIVE`. */
  async cancelClosure(caller: Caller): Promise<{ status: AccountStatus }> {
    return this.d.store.transaction(async (tx) => {
      const account = await this.callerAccount(caller, tx, true);
      if (account.status !== 'CLOSING')
        throw rule('INVALID_ACCOUNT_TRANSITION', 'A conta não está em encerramento.');
      await this.setStatus(
        tx,
        account,
        statusFor('ACTIVE', account.restrictions),
        'CUSTOMER_GAVE_UP',
        { type: 'USER', id: caller.userId },
      );
      return { status: account.status };
    });
  }

  private async closurePendencies(accountId: string): Promise<ClosurePendency[]> {
    const missing = CLOSURE_SOURCES.filter(
      (s) => !this.d.closureChecks.some((c) => c.source === s),
    );
    if (missing.length > 0)
      throw new CustomerError(
        503,
        'CLOSURE_CHECK_UNAVAILABLE',
        `Sem verificação de pendências de: ${missing.join(', ')}.`,
      );
    try {
      return (await Promise.all(this.d.closureChecks.map((c) => c.pendencies(accountId)))).flat();
    } catch {
      // Na dúvida, não encerra: uma pendência desconhecida é pendência.
      throw new CustomerError(
        503,
        'CLOSURE_CHECK_UNAVAILABLE',
        'Não foi possível verificar as pendências agora.',
      );
    }
  }

  // ---------------------------------------------------------------- contas de saque (RN-ACC-020/021)

  async withdrawalAccounts(caller: Caller) {
    return this.d.store.transaction(async (tx) => {
      const account = await this.callerAccount(caller, tx);
      return (await tx.withdrawalAccounts(account.id)).map((w) => ({
        id: w.id,
        pixKeyType: w.pixKeyType,
        pixKey: maskKey(this.d.fields.open(w.pixKeyEnc, CTX.pixKey)),
        holderName: w.holderNameMasked,
        availableFrom: w.availableFrom.toString(),
        available: !this.d.clock.now().isBefore(w.availableFrom),
      }));
    });
  }

  /**
   * Cadastra uma chave PIX de saque: até 3, mesma titularidade pelo CPF que o Banco Simulado
   * devolve, carência de 24 h. A rota exige assinatura eletrônica e MFA recente.
   */
  async addWithdrawalAccount(caller: Caller, pixKey: string) {
    const key = pixKey.trim();
    const { account, customer } = await this.d.store.transaction(async (tx) => {
      const account = await this.callerAccount(caller, tx);
      if (account.status === 'BLOCKED' || account.status === 'CLOSED')
        throw rule('ACCOUNT_NOT_ACTIVE', `Conta ${account.status}.`);
      if ((await tx.withdrawalAccounts(account.id)).length >= MAX_WITHDRAWAL_ACCOUNTS)
        throw rule(
          'WITHDRAWAL_ACCOUNT_LIMIT',
          `No máximo ${MAX_WITHDRAWAL_ACCOUNTS} contas de saque.`,
        );
      return { account, customer: (await tx.customer(account.customerId))! };
    });
    const holder = await this.d.bank.lookupKey(key);
    if (!holder) throw rule('PIX_KEY_NOT_FOUND', 'Chave PIX inexistente.');
    if (holder.holderTaxId !== this.d.fields.open(customer.taxIdEnc, CTX.taxId))
      throw rule('BANK_ACCOUNT_NOT_ALLOWED', 'A chave precisa ser de uma conta sua (mesmo CPF).');
    const now = this.d.clock.now();
    const id = this.d.newId();
    const result = await this.d.store.transaction(async (tx) => {
      if ((await tx.withdrawalAccounts(account.id)).length >= MAX_WITHDRAWAL_ACCOUNTS)
        throw rule(
          'WITHDRAWAL_ACCOUNT_LIMIT',
          `No máximo ${MAX_WITHDRAWAL_ACCOUNTS} contas de saque.`,
        );
      return tx.insertWithdrawalAccount({
        id,
        accountId: account.id,
        pixKeyEnc: this.d.fields.seal(key, CTX.pixKey),
        pixKeyHash: this.d.fields.hash(key, HASH.pixKey),
        pixKeyType: holder.type,
        holderNameMasked: holder.holderNameMasked,
        status: 'ACTIVE',
        availableFrom: now.plusMillis(WITHDRAWAL_ACCOUNT_GRACE_MS),
        createdAt: now,
      });
    });
    if (result === 'DUPLICATE')
      throw new CustomerError(409, 'WITHDRAWAL_ACCOUNT_EXISTS', 'Essa chave já está cadastrada.');
    return { id, availableFrom: now.plusMillis(WITHDRAWAL_ACCOUNT_GRACE_MS).toString() };
  }

  async removeWithdrawalAccount(caller: Caller, id: string): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      const account = await this.callerAccount(caller, tx);
      const w = await tx.withdrawalAccount(id);
      if (!w || w.accountId !== account.id || w.status !== 'ACTIVE')
        throw notFound('Conta de saque inexistente.');
      await tx.removeWithdrawalAccount(id);
    });
  }

  // ---------------------------------------------------------------- cadastro (RN-CAD-001..004)

  async profile(caller: Caller) {
    return this.d.store.transaction(async (tx) => {
      const customer = await tx.customerOfUser(caller.userId);
      if (!customer) throw notFound('Ainda não há cliente: conclua o onboarding.');
      const account = await tx.accountOfCustomer(customer.id);
      const assessment = await tx.latestAssessment(caller.userId);
      const o = (v: string, c: string) => this.d.fields.open(v, c);
      return {
        customerId: customer.id,
        fullName: o(customer.fullNameEnc, CTX.fullName),
        socialName: customer.socialNameEnc ? o(customer.socialNameEnc, CTX.socialName) : null,
        email: o(customer.emailEnc, CTX.email),
        phone: o(customer.phoneEnc, CTX.phone),
        address: openJson<Address>(this.d, customer.addressEnc, CTX.customerAddress),
        registrationValidUntil: customer.registrationValidUntil.toString(),
        account: account && {
          accountId: account.id,
          accountNumber: account.accountNumber,
          status: account.status,
          restrictions: account.restrictions,
          permissions: permissions(account.status, account.restrictions),
        },
        suitability: assessment && {
          profile: assessment.profile,
          validUntil: assessment.validUntil.toString(),
        },
        pendingTerms: await this.terms.pendingMandatory(tx, caller.userId),
      };
    });
  }

  /**
   * Troca de e-mail, celular ou endereço (RN-CAD-001): a rota já exigiu a reautenticação
   * (assinatura eletrônica); aqui saem os códigos para o canal antigo e para o novo.
   */
  async requestContactChange(
    caller: Caller,
    kind: 'EMAIL' | 'PHONE' | 'ADDRESS',
    value: string | Address,
  ) {
    if (kind === 'EMAIL' && !(typeof value === 'string' && EMAIL.test(value)))
      throw invalid('email', 'INVALID_EMAIL', 'E-mail inválido.');
    if (kind === 'PHONE' && !(typeof value === 'string' && isE164(value)))
      throw invalid('phone', 'INVALID_PHONE', 'Use o formato +5511987654321.');
    if (kind === 'ADDRESS') {
      const a = value as Address;
      if (!isCep(a.zipCode) || !isUf(a.state) || !a.street || !a.number || !a.city || !a.district)
        throw invalid('address', 'INVALID_ADDRESS', 'Endereço incompleto ou inválido.');
    }
    const normalized = kind === 'EMAIL' ? (value as string).trim().toLowerCase() : value;
    const oldCode = this.d.random.digits(6);
    const newCode = this.d.random.digits(6);
    const { id, oldEmail, oldPhone } = await this.d.store.transaction(async (tx) => {
      const customer = await this.callerCustomer(caller, tx);
      if (
        kind === 'EMAIL' &&
        (await tx.emailInUse(this.d.fields.hash(normalized as string, HASH.email), caller.userId))
      )
        throw rule('EMAIL_ALREADY_IN_USE', 'Esse e-mail já está em uso.');
      const now = this.d.clock.now();
      const id = this.d.newId();
      await tx.insertProfileChange({
        id,
        customerId: customer.id,
        kind,
        newValueEnc: sealJson(this.d, normalized, CTX.change),
        documentKey: null,
        otpOldHash: this.d.random.sha256(oldCode),
        otpNewHash: this.d.random.sha256(newCode),
        attempts: 0,
        status: 'PENDING_OTP',
        createdAt: now,
        expiresAt: now.plusMillis(CHANGE_OTP_TTL_MS),
        decidedBy: null,
      });
      return {
        id,
        oldEmail: this.d.fields.open(customer.emailEnc, CTX.email),
        oldPhone: this.d.fields.open(customer.phoneEnc, CTX.phone),
      };
    });
    // Canal antigo e novo: na troca de endereço, os dois canais atuais (e-mail e celular).
    if (kind === 'PHONE') {
      await this.d.messenger.sms(oldPhone, `Código para confirmar a troca de celular: ${oldCode}`);
      await this.d.messenger.sms(
        normalized as string,
        `Código de verificação do novo celular: ${newCode}`,
      );
    } else if (kind === 'EMAIL') {
      await this.d.messenger.email(
        oldEmail,
        'Troca de e-mail',
        `Código para confirmar a troca de e-mail: ${oldCode}`,
      );
      await this.d.messenger.email(
        normalized as string,
        'Confirme seu novo e-mail',
        `Código de verificação: ${newCode}`,
      );
    } else {
      await this.d.messenger.email(
        oldEmail,
        'Troca de endereço',
        `Código para confirmar a troca de endereço: ${oldCode}`,
      );
      await this.d.messenger.sms(oldPhone, `Código para confirmar a troca de endereço: ${newCode}`);
    }
    return { changeId: id };
  }

  async confirmContactChange(
    caller: Caller,
    changeId: string,
    codes: { oldCode: string; newCode: string },
  ): Promise<void> {
    const result = await this.d.store.transaction(async (tx) => {
      const customer = await this.callerCustomer(caller, tx);
      const change = await tx.profileChange(changeId, { forUpdate: true });
      if (!change || change.customerId !== customer.id || change.status !== 'PENDING_OTP')
        throw notFound('Alteração inexistente.');
      if (
        change.attempts >= CHANGE_OTP_ATTEMPTS ||
        !this.d.clock.now().isBefore(change.expiresAt!)
      ) {
        await tx.saveProfileChange({ ...change, status: 'EXPIRED' });
        return { error: rule('OTP_EXPIRED', 'Os códigos expiraram. Peça a alteração de novo.') };
      }
      if (
        change.otpOldHash !== this.d.random.sha256(codes.oldCode) ||
        change.otpNewHash !== this.d.random.sha256(codes.newCode)
      ) {
        await tx.saveProfileChange({ ...change, attempts: change.attempts + 1 });
        return { error: invalid('code', 'INVALID_OTP', 'Código incorreto.') };
      }
      await this.apply(
        tx,
        customer,
        change.kind,
        openJson<string | Address>(this.d, change.newValueEnc, CTX.change),
        caller.userId,
      );
      await tx.saveProfileChange({ ...change, status: 'APPLIED' });
      return { ok: true as const };
    });
    if ('error' in result) throw result.error;
  }

  /**
   * Troca de nome ou documento (RN-CAD-002): exige documento novo e revisão manual. Devolve a URL
   * para o upload do documento; a alteração fica pendente até o backoffice decidir.
   */
  async requestReviewedChange(
    caller: Caller,
    kind: 'NAME' | 'ID_DOCUMENT',
    value: string | Record<string, unknown>,
  ) {
    if (kind === 'NAME') {
      const issue = validateName('fullName', value as string);
      if (issue) throw invalid(issue.field, issue.code, issue.message);
    }
    const id = this.d.newId();
    const key = await this.d.store.transaction(async (tx) => {
      const customer = await this.callerCustomer(caller, tx);
      const key = `profile/${customer.id}/${id}`;
      await tx.insertProfileChange({
        id,
        customerId: customer.id,
        kind,
        newValueEnc: sealJson(this.d, value, CTX.change),
        documentKey: key,
        otpOldHash: null,
        otpNewHash: null,
        attempts: 0,
        status: 'PENDING_REVIEW',
        createdAt: this.d.clock.now(),
        expiresAt: null,
        decidedBy: null,
      });
      return key;
    });
    return {
      changeId: id,
      uploadUrl: await this.d.documents.uploadUrl(key, 'image/jpeg', 10 * 1024 * 1024, 600),
    };
  }

  async reviewQueue() {
    return this.d.store.transaction(async (tx) =>
      (await tx.pendingReviews(100)).map((c) => ({
        changeId: c.id,
        customerId: c.customerId,
        kind: c.kind,
        createdAt: c.createdAt.toString(),
      })),
    );
  }

  async reviewChange(op: Operator, changeId: string, approve: boolean): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      const change = await tx.profileChange(changeId, { forUpdate: true });
      if (!change || change.status !== 'PENDING_REVIEW') throw notFound('Alteração inexistente.');
      if (approve) {
        const customer = (await tx.customer(change.customerId))!;
        await this.apply(
          tx,
          customer,
          change.kind,
          openJson<string | Record<string, unknown>>(this.d, change.newValueEnc, CTX.change),
          op.id,
        );
      }
      await tx.saveProfileChange({
        ...change,
        status: approve ? 'APPLIED' : 'REJECTED',
        decidedBy: op.id,
      });
    });
  }

  async history(caller: Caller) {
    return this.d.store.transaction(async (tx) => {
      const customer = await this.callerCustomer(caller, tx);
      return (await tx.history(customer.id)).map((h) => ({
        field: h.field,
        actorId: h.actorId,
        at: h.at.toString(),
      }));
    });
  }

  /** O cliente confirma que os dados estão em dia: o cadastro vale mais 24 meses (RN-CAD-003). */
  async confirmRegistration(caller: Caller): Promise<{ registrationValidUntil: string }> {
    return this.d.store.transaction(async (tx) => {
      const customer = await this.callerCustomer(caller, tx);
      const until = await this.renew(tx, customer, caller.userId);
      return { registrationValidUntil: until.toString() };
    });
  }

  /** Rotina diária: cadastro vencido → conta `RESTRICTED` com `REGISTRATION_EXPIRED`. */
  async restrictExpiredRegistrations(today: BusinessDate): Promise<number> {
    return this.d.store.transaction(async (tx) => {
      let n = 0;
      for (const customer of await tx.customersWithRegistrationBefore(today, 500)) {
        const account = await tx.accountOfCustomer(customer.id);
        if (!account) continue;
        const before = account.restrictions.includes('REGISTRATION_EXPIRED');
        await this.setRestriction(tx, account.id, 'REGISTRATION_EXPIRED', true, {
          type: 'SYSTEM',
          id: 'customer-service',
        });
        if (!before) n++;
      }
      return n;
    });
  }

  // ---------------------------------------------------------------- internos

  /** Aplica a alteração, grava o histórico (anterior e nova, ator, data) e renova o cadastro. */
  private async apply(
    tx: CustomerTx,
    customer: CustomerRow,
    kind: ChangeKind,
    value: unknown,
    actorId: string,
  ): Promise<void> {
    const columns: Record<
      ChangeKind,
      { field: string; old: string; patch: Parameters<CustomerTx['updateCustomer']>[1] }
    > = {
      EMAIL: {
        field: 'email',
        old: customer.emailEnc,
        patch: {
          emailEnc: this.d.fields.seal(value as string, CTX.email),
          emailHash: this.d.fields.hash(value as string, HASH.email),
        },
      },
      PHONE: {
        field: 'phone',
        old: customer.phoneEnc,
        patch: { phoneEnc: this.d.fields.seal(value as string, CTX.phone) },
      },
      ADDRESS: {
        field: 'address',
        old: customer.addressEnc,
        patch: { addressEnc: sealJson(this.d, value, CTX.customerAddress) },
      },
      NAME: {
        field: 'fullName',
        old: customer.fullNameEnc,
        patch: { fullNameEnc: this.d.fields.seal(value as string, CTX.fullName) },
      },
      ID_DOCUMENT: {
        field: 'idDocument',
        old: customer.idDocumentEnc,
        patch: { idDocumentEnc: sealJson(this.d, value, CTX.idDocument) },
      },
    };
    const c = columns[kind];
    const contexts: Record<ChangeKind, string> = {
      EMAIL: CTX.email,
      PHONE: CTX.phone,
      ADDRESS: CTX.customerAddress,
      NAME: CTX.fullName,
      ID_DOCUMENT: CTX.idDocument,
    };
    const oldPlain = this.d.fields.open(c.old, contexts[kind]);
    await tx.updateCustomer(customer.id, c.patch);
    await tx.insertHistory({
      id: this.d.newId(),
      customerId: customer.id,
      field: c.field,
      oldValueEnc: this.d.fields.seal(oldPlain, CTX.history),
      newValueEnc: this.d.fields.seal(
        typeof value === 'string' ? value : JSON.stringify(value),
        CTX.history,
      ),
      actorId,
      at: this.d.clock.now(),
    });
    await tx.publish(
      { type: 'customer.updated', payload: { customerId: customer.id, changedFields: [c.field] } },
      customer.id,
    );
    await this.renew(tx, customer, actorId);
  }

  private async renew(tx: CustomerTx, customer: CustomerRow, actorId: string) {
    const until = plusMonths(this.d.clock.now().businessDate(), REGISTRATION_VALIDITY_MONTHS);
    await tx.updateCustomer(customer.id, { registrationValidUntil: until });
    const account = await tx.accountOfCustomer(customer.id);
    if (account?.restrictions.includes('REGISTRATION_EXPIRED')) {
      await this.setRestriction(tx, account.id, 'REGISTRATION_EXPIRED', false, {
        type: 'USER',
        id: actorId,
      });
    }
    return until;
  }

  private async callerCustomer(caller: Caller, tx: CustomerTx): Promise<CustomerRow> {
    const customer = await tx.customerOfUser(caller.userId);
    if (!customer) throw notFound('Ainda não há cliente: conclua o onboarding.');
    return customer;
  }

  private async callerAccount(
    caller: Caller,
    tx?: CustomerTx,
    forUpdate = false,
  ): Promise<AccountRow> {
    const run = async (t: CustomerTx) => {
      const customer = await this.callerCustomer(caller, t);
      const account = await t.accountOfCustomer(customer.id, { forUpdate });
      if (!account) throw notFound('Conta inexistente.');
      return account;
    };
    return tx ? run(tx) : this.d.store.transaction(run);
  }
}

const maskKey = (key: string) =>
  key.length <= 4 ? '****' : `${'*'.repeat(Math.max(4, key.length - 4))}${key.slice(-4)}`;
