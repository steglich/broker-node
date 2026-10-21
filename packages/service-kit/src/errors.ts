import { DomainError } from '@broker/domain-kernel';

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

/** Títulos padrão em pt-BR (RN-API-030). */
const TITLES: Record<string, string> = {
  VALIDATION_ERROR: 'Requisição inválida',
  MALFORMED_JSON: 'JSON malformado',
  PAYLOAD_TOO_LARGE: 'Corpo da requisição grande demais',
  UNAUTHENTICATED: 'Autenticação necessária',
  FORBIDDEN: 'Acesso negado',
  INSUFFICIENT_SCOPE: 'Permissão insuficiente',
  FEATURE_UNAVAILABLE: 'Funcionalidade indisponível',
  NOT_FOUND: 'Recurso não encontrado',
  IDEMPOTENCY_KEY_REQUIRED: 'Idempotency-Key obrigatória',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency-Key reutilizada com outra requisição',
  IDEMPOTENCY_REQUEST_IN_PROGRESS: 'Requisição com esta Idempotency-Key ainda em processamento',
  VERSION_CONFLICT: 'O recurso foi alterado por outra operação',
  IF_MATCH_REQUIRED: 'If-Match obrigatório',
  INTERNAL_ERROR: 'Erro interno',
  SERVICE_UNAVAILABLE: 'Serviço temporariamente indisponível',
};

/** Erro com representação HTTP (Problem Details, RFC 9457). */
export class HttpError extends Error {
  override readonly name = 'HttpError';

  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
    readonly extra: {
      title?: string;
      errors?: FieldError[];
      context?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(detail ?? code);
  }

  get title(): string {
    return this.extra.title ?? TITLES[this.code] ?? this.code;
  }
}

export const validationError = (
  errors: FieldError[],
  detail = 'A requisição tem campos inválidos.',
) => new HttpError(400, 'VALIDATION_ERROR', detail, { errors });
export const unauthenticated = (detail = 'Envie um token de acesso válido.') =>
  new HttpError(401, 'UNAUTHENTICATED', detail, { headers: { 'WWW-Authenticate': 'Bearer' } });
export const forbidden = (code = 'FORBIDDEN', detail?: string) => new HttpError(403, code, detail);
/** Recurso inexistente ou de outro dono: a resposta é a mesma (RN-AUTHZ-002). */
export const notFound = (detail = 'Recurso não encontrado.') =>
  new HttpError(404, 'NOT_FOUND', detail);
export const conflict = (code: string, detail?: string) => new HttpError(409, code, detail);
/** Regra de negócio violada: `422` com o código do domínio (RN-BE-030). */
export const businessRule = (code: string, detail: string, context?: Record<string, unknown>) =>
  new HttpError(422, code, detail, { title: detail, ...(context ? { context } : {}) });
export const serviceUnavailable = (
  code = 'SERVICE_UNAVAILABLE',
  detail = 'Tente novamente em instantes.',
) => new HttpError(503, code, detail, { headers: { 'Retry-After': '5' } });

/** Códigos SQLSTATE e de rede que indicam dependência indisponível (não é bug do serviço). */
const UNAVAILABLE_SQLSTATE = /^(08|53300|57P01|57P02|57P03)/;
const UNAVAILABLE_ERRNO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
]);

export function isDependencyUnavailable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  if (
    UNAVAILABLE_SQLSTATE.test(code) ||
    UNAVAILABLE_ERRNO.has(code) ||
    code.startsWith('UND_ERR_') ||
    code === 'EOPENBREAKER'
  ) {
    return true;
  }
  if (
    typeof e.message === 'string' &&
    /Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect/i.test(
      e.message,
    )
  ) {
    return true;
  }
  if (Array.isArray(e.errors) && e.errors.some(isDependencyUnavailable)) return true; // AggregateError
  return e.cause !== undefined && isDependencyUnavailable(e.cause);
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance: string;
  correlationId: string;
  errors?: FieldError[];
  context?: Record<string, unknown>;
}

const kebab = (code: string) => code.toLowerCase().replace(/_/g, '-');

/**
 * Converte qualquer erro em Problem Details (RFC 9457, RN-BE-030..032). Erros técnicos viram
 * `SERVICE_UNAVAILABLE` (dependência fora) ou `INTERNAL_ERROR`, sem mensagem nem stack interna.
 */
export function toProblem(
  err: unknown,
  instance: string,
  correlationId: string,
): { problem: Problem; headers: Record<string, string> } {
  let http: HttpError;
  if (err instanceof HttpError) http = err;
  else if (err instanceof DomainError) http = businessRule(err.code, err.message);
  else if (isDependencyUnavailable(err)) http = serviceUnavailable();
  else
    http = new HttpError(
      500,
      'INTERNAL_ERROR',
      'Ocorreu um erro inesperado. Informe o correlationId ao suporte.',
    );

  const problem: Problem = {
    type: `https://docs.corretora-estudo.local/errors/${kebab(http.code)}`,
    title: http.title,
    status: http.status,
    code: http.code,
    ...(http.detail ? { detail: http.detail } : {}),
    instance,
    correlationId,
    ...(http.extra.errors ? { errors: http.extra.errors } : {}),
    ...(http.extra.context ? { context: http.extra.context } : {}),
  };
  return { problem, headers: http.extra.headers ?? {} };
}
