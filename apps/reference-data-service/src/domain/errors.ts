/** Regra de negócio violada no domínio; o adaptador HTTP traduz em `422` com o código. */
export class ReferenceRuleError extends Error {
  override readonly name = 'ReferenceRuleError';

  constructor(
    readonly code: string,
    message: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
  }
}
