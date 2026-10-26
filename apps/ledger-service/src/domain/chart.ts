/**
 * Plano de contas (Financeiro §3). Uma conta é identificada por `(code, ownerId)`: as do cliente têm
 * o `account_id` da conta de investimento como dono; as da casa não têm dono.
 */
export type CustomerAccountCode = 'CUST_CASH' | 'CUST_CASH_COLLATERAL';
export type HouseAccountCode =
  | 'HOUSE_PIX_RESERVE'
  | 'CLEARING_HOUSE'
  | 'SMM_CASH'
  | 'REV_BROKERAGE'
  | 'REV_CUSTODY'
  | 'REV_INTEREST'
  | 'REV_BTC_FEE'
  | 'PAY_B3_TRADING_FEE'
  | 'PAY_B3_SETTLEMENT_FEE'
  | 'PAY_ISS'
  | 'PAY_IRRF'
  | 'ISSUER_DISTRIBUTIONS'
  | 'HOUSE_ADJUSTMENTS'
  | 'BTC_POOL'
  | 'PAY_TAX_DARF';
export type AccountCode = CustomerAccountCode | HouseAccountCode;

export type OwnerType = 'CUSTOMER' | 'HOUSE' | 'SMM';

/** Lado em que o saldo da conta fica normalmente, na convenção de sinal do ledger (ver `journal.ts`). */
export type NormalSide = 'CREDIT' | 'DEBIT';

export interface AccountSpec {
  code: AccountCode;
  ownerType: OwnerType;
  normalSide: NormalSide;
  /**
   * RN-LED-011: só `SMM_CASH`, `CLEARING_HOUSE`, `ISSUER_DISTRIBUTIONS` e as `PAY_*`/`REV_*` podem
   * ter saldo de qualquer sinal. As outras não passam para o lado contrário ao `normalSide`.
   */
  anySign: boolean;
  description: string;
}

export interface AccountRef {
  code: AccountCode;
  /** `account_id` do cliente; `null` nas contas da casa. */
  ownerId: string | null;
}

export const CUSTOMER_ACCOUNTS: readonly AccountSpec[] = [
  {
    code: 'CUST_CASH',
    ownerType: 'CUSTOMER',
    normalSide: 'CREDIT',
    anySign: false,
    description: 'Caixa do cliente',
  },
  {
    code: 'CUST_CASH_COLLATERAL',
    ownerType: 'CUSTOMER',
    normalSide: 'CREDIT',
    anySign: false,
    description: 'Garantias em dinheiro',
  },
];

const house = (
  code: HouseAccountCode,
  normalSide: NormalSide,
  anySign: boolean,
  description: string,
  ownerType: OwnerType = 'HOUSE',
): AccountSpec => ({ code, ownerType, normalSide, anySign, description });

/**
 * Contas da casa (§3.2), criadas só por migração (RN-LED-010). O lado normal segue a natureza: a
 * reserva PIX e a câmara são ativos (saldo devedor, negativo na convenção); receitas e repasses
 * são credores.
 */
export const HOUSE_ACCOUNTS: readonly AccountSpec[] = [
  house('HOUSE_PIX_RESERVE', 'DEBIT', false, 'Reserva PIX'),
  house('CLEARING_HOUSE', 'DEBIT', true, 'Câmara de liquidação'),
  house('SMM_CASH', 'CREDIT', true, 'Caixa do FMS', 'SMM'),
  house('REV_BROKERAGE', 'CREDIT', true, 'Receita de corretagem'),
  house('REV_CUSTODY', 'CREDIT', true, 'Receita de custódia'),
  house('REV_INTEREST', 'CREDIT', true, 'Receita de juros'),
  house('REV_BTC_FEE', 'CREDIT', true, 'Receita de BTC'),
  house('PAY_B3_TRADING_FEE', 'CREDIT', true, 'Emolumentos a repassar'),
  house('PAY_B3_SETTLEMENT_FEE', 'CREDIT', true, 'Taxa de liquidação a repassar'),
  house('PAY_ISS', 'CREDIT', true, 'ISS a recolher'),
  house('PAY_IRRF', 'CREDIT', true, 'IRRF a recolher'),
  house('ISSUER_DISTRIBUTIONS', 'DEBIT', true, 'Emissor simulado'),
  house('HOUSE_ADJUSTMENTS', 'DEBIT', false, 'Ajustes operacionais'),
  house('BTC_POOL', 'CREDIT', false, 'Pool BTC'),
  house('PAY_TAX_DARF', 'CREDIT', true, 'Impostos pagos via DARF'),
];

export const isCustomerAccount = (code: AccountCode): code is CustomerAccountCode =>
  code === 'CUST_CASH' || code === 'CUST_CASH_COLLATERAL';

export const houseAccount = (code: HouseAccountCode): AccountRef => ({ code, ownerId: null });
export const customerCash = (accountId: string): AccountRef => ({
  code: 'CUST_CASH',
  ownerId: accountId,
});

export const accountKey = (ref: AccountRef) => `${ref.code}:${ref.ownerId ?? '-'}`;
