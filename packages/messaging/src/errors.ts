/**
 * Erro permanente: repetir não adianta (validação, esquema, regra violada). Vai direto para a
 * DLQ, sem retentativas (RN-MSG-B-034). Qualquer outro erro é tratado como transitório.
 */
export class PermanentError extends Error {
  override readonly name = 'PermanentError';
}

/** Mensagem inválida no consumo (envelope, esquema ou ambiente): sempre permanente. */
export class InvalidMessageError extends PermanentError {}

/** Publicação recusada no produtor (esquema, tamanho ou dado pessoal): nada é gravado. */
export class PublishRejectedError extends Error {
  override readonly name = 'PublishRejectedError';

  constructor(
    readonly reason: 'SCHEMA' | 'PAYLOAD_TOO_LARGE' | 'PERSONAL_DATA',
    message: string,
  ) {
    super(message);
  }
}

export const isPermanent = (err: unknown): boolean => err instanceof PermanentError;
