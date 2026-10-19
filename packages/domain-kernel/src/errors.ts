/** Códigos de erro de domínio dos objetos de valor. */
export type DomainErrorCode =
  | 'INVALID_DECIMAL'
  | 'INVALID_QUANTITY'
  | 'INVALID_CURRENCY'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_SCALE'
  | 'INVALID_ALLOCATION'
  | 'TAX_ID_INVALID'
  | 'INVALID_DATE'
  | 'INVALID_INSTANT';

/** Erro de regra de domínio, com código estável para mapear em Problem Details (RFC 9457). */
export class DomainError extends Error {
  override readonly name = 'DomainError';

  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
  }
}
