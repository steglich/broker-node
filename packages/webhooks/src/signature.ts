import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@broker/clock';

export const SIGNATURE_HEADER = 'x-signature';
export const TIMESTAMP_HEADER = 'x-timestamp';
/** Desvio máximo aceito entre o `X-Timestamp` e o relógio do receptor (RN-SIM-003). */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Assinatura de webhook (RN-SIM-003): HMAC-SHA256, em hex, sobre `timestamp + "." + corpo`.
 * O timestamp (segundos Unix) entra na assinatura: um atacante que capture um webhook não consegue
 * reaproveitá-lo depois da janela de 5 minutos trocando só o header.
 */
export function signWebhook(secret: string, timestamp: number, body: string | Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

/** Headers de um webhook assinado no instante `nowMs`. */
export function signedHeaders(secret: string, nowMs: number, body: string): Record<string, string> {
  const timestamp = Math.floor(nowMs / 1000);
  return {
    'X-Timestamp': String(timestamp),
    'X-Signature': signWebhook(secret, timestamp, body),
  };
}

export type WebhookRejection =
  'MISSING_HEADERS' | 'INVALID_TIMESTAMP' | 'STALE_TIMESTAMP' | 'INVALID_SIGNATURE';

export type VerificationResult =
  { ok: true; timestamp: number } | { ok: false; reason: WebhookRejection };

export interface VerifyOptions {
  secret: string;
  /** Relógio do receptor (o mesmo do ambiente que assina). */
  clock: Clock;
  maxSkewMs?: number;
}

const header = (headers: Record<string, string | string[] | undefined>, name: string) => {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Lado receptor: confere o timestamp (desvio > 5 min, para trás ou para frente, é recusado) e a
 * assinatura em tempo constante. `rawBody` tem de ser os bytes recebidos, não o JSON re-serializado.
 */
export function verifyWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string | Buffer | undefined,
  options: VerifyOptions,
): VerificationResult {
  const signature = header(headers, SIGNATURE_HEADER);
  const ts = header(headers, TIMESTAMP_HEADER);
  if (!signature || !ts || rawBody === undefined) return { ok: false, reason: 'MISSING_HEADERS' };
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: 'INVALID_TIMESTAMP' };
  const timestamp = Number(ts);
  const skew = Math.abs(options.clock.now().epochMillis - timestamp * 1000);
  if (skew > (options.maxSkewMs ?? MAX_CLOCK_SKEW_MS))
    return { ok: false, reason: 'STALE_TIMESTAMP' };
  const expected = Buffer.from(signWebhook(options.secret, timestamp, rawBody), 'hex');
  const given = /^[0-9a-f]{64}$/i.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'INVALID_SIGNATURE' };
  }
  return { ok: true, timestamp };
}
