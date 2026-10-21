import type { Clock } from '@broker/clock';
import { trace } from '@opentelemetry/api';
import pino, { type DestinationStream, type Logger } from 'pino';
import { currentContext } from './context.js';

/** Campos mascarados por nome, em qualquer profundidade (RN-BE-051). Comparação sem `_`/`-`/caixa. */
const SECRET_FIELDS = new Set([
  'password',
  'senha',
  'newpassword',
  'currentpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'signaturetoken',
  'secret',
  'clientsecret',
  'apikey',
  'authorization',
  'cookie',
  'setcookie',
  'otp',
  'totp',
  'pin',
  'tradingsignature',
  'document',
  'documentnumber',
  'rg',
]);
const TAX_ID_FIELDS = new Set(['cpf', 'taxid']);
const normalize = (k: string) => k.toLowerCase().replace(/[_-]/g, '');

/** `***.456.789-**` para um CPF de 11 dígitos; qualquer outra coisa sai inteiramente oculta. */
function maskTaxId(value: unknown): string {
  const digits = typeof value === 'string' ? value.replace(/\D/g, '') : '';
  return digits.length === 11 ? `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**` : '[REDACTED]';
}

/** Cópia do objeto com os campos sensíveis mascarados. */
export function maskSensitive(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => maskSensitive(v, depth + 1));
  if (value instanceof Error) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const k = normalize(key);
    if (SECRET_FIELDS.has(k)) out[key] = '[REDACTED]';
    else if (TAX_ID_FIELDS.has(k)) out[key] = maskTaxId(child);
    else out[key] = maskSensitive(child, depth + 1);
  }
  return out;
}

export interface LoggerOptions {
  service: string;
  environment: string;
  version: string;
  level?: string;
  /** Relógio do ambiente: `timestamp` usa ele; `wall_clock_at` usa o relógio da máquina (RN-CLK-004). */
  clock: Clock;
  /** Destino (padrão stdout); os testes passam um stream em memória. */
  destination?: DestinationStream;
}

/**
 * Logger JSON (RN-BE-050..052) com os campos mínimos: `timestamp` (UTC, relógio do ambiente),
 * `wall_clock_at` (relógio da máquina), `level`, `service`, `environment`, `version`,
 * `correlation_id`, `trace_id`, `span_id`, `message` e `event` (código do log, passado por quem loga).
 */
export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level ?? 'info',
      messageKey: 'message',
      base: {
        service: options.service,
        environment: options.environment,
        version: options.version,
      },
      timestamp: () =>
        `,"timestamp":"${options.clock.now().toString()}","wall_clock_at":"${new Date().toISOString()}"`,
      formatters: {
        level: (label) => ({ level: label.toUpperCase() }),
        log: (obj) => maskSensitive(obj) as Record<string, unknown>,
      },
      mixin: () => {
        const ctx = currentContext();
        const span = trace.getActiveSpan()?.spanContext();
        return {
          ...(ctx ? { correlation_id: ctx.correlationId } : {}),
          ...(span && span.traceId !== '00000000000000000000000000000000'
            ? { trace_id: span.traceId, span_id: span.spanId }
            : {}),
        };
      },
      serializers: { err: pino.stdSerializers.err },
    },
    options.destination,
  );
}

export type { Logger };
