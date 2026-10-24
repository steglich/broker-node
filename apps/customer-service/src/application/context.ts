import type { Clock } from '@broker/clock';
import type {
  BankPort,
  ClosureCheck,
  CustomerStore,
  DocumentStorage,
  FieldProtection,
  KycProvider,
  Messenger,
  Randomness,
} from './ports.js';

export interface CustomerDeps {
  store: CustomerStore;
  clock: Clock;
  newId: () => string;
  fields: FieldProtection;
  random: Randomness;
  documents: DocumentStorage;
  kyc: KycProvider;
  bank: BankPort;
  messenger: Messenger;
  /** Um verificador por dono de pendência; faltar algum torna o encerramento indisponível. */
  closureChecks: readonly ClosureCheck[];
}

/** Erro de caso de uso, traduzido pelo adaptador HTTP em Problem Details. */
export class CustomerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Recurso inexistente.') =>
  new CustomerError(404, 'NOT_FOUND', what);
export const rule = (code: string, message: string, context?: Record<string, unknown>) =>
  new CustomerError(422, code, message, undefined, context);
export const invalid = (field: string, code: string, message: string) =>
  new CustomerError(400, code, message, field);

/** Contextos de cifra (AAD): um valor copiado para outra coluna não decifra. */
export const CTX = {
  contact: 'onboarding.contact',
  personal: 'onboarding.personal',
  address: 'onboarding.address',
  financial: 'onboarding.financial',
  fullName: 'customer.full_name',
  socialName: 'customer.social_name',
  taxId: 'customer.tax_id',
  birthDate: 'customer.birth_date',
  motherName: 'customer.mother_name',
  email: 'customer.email',
  phone: 'customer.phone',
  customerAddress: 'customer.address',
  idDocument: 'customer.id_document',
  pixKey: 'withdrawal_account.pix_key',
  change: 'profile_change.value',
  history: 'customer_change_history.value',
} as const;

/** HMAC de busca por contexto (CPF, e-mail, chave PIX). */
export const HASH = { taxId: 'tax_id', email: 'email', pixKey: 'pix_key' } as const;

export const sealJson = (d: CustomerDeps, value: unknown, ctx: string) =>
  d.fields.seal(JSON.stringify(value), ctx);
export const openJson = <T>(d: CustomerDeps, stored: string, ctx: string): T =>
  JSON.parse(d.fields.open(stored, ctx)) as T;

/** Quem age numa rota autenticada (do access token validado pelo service-kit). */
export interface Caller {
  userId: string;
  accountId?: string;
  ip?: string;
  userAgent?: string;
  channel: string;
}

export interface Operator {
  id: string;
  roles: readonly string[];
}
