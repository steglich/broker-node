import { HttpError } from '@broker/service-kit';
import { verifyWebhook, type VerifyOptions } from './signature.js';

/**
 * Para rotas do service-kit que recebem webhook: lança `401 INVALID_WEBHOOK_SIGNATURE` (RN-SIM-003)
 * antes de qualquer efeito. Use com `req.headers` e `req.rawBody` do handler.
 */
export function assertWebhookSignature(
  req: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer | undefined },
  options: VerifyOptions,
): void {
  const result = verifyWebhook(req.headers, req.rawBody, options);
  if (!result.ok) {
    throw new HttpError(401, 'INVALID_WEBHOOK_SIGNATURE', `Webhook recusado: ${result.reason}.`);
  }
}
