import type { BlindIndex, FieldCipher } from '@broker/persistence';
import type { ServiceTokenProvider } from '@broker/service-kit';
import nodemailer, { type Transporter } from 'nodemailer';
import { randomUUID } from 'node:crypto';
import {
  DeliveryError,
  type EmailSender,
  type MessageSinkPort,
  type OutgoingEmail,
  type Recipient,
  type RecipientDirectory,
  type RecipientRef,
  type SinkResult,
  type TokenProtection,
} from '../application/ports.js';

const TIMEOUT_MS = 10_000;

/** Rede, timeout, `429` e `5xx` são transitórios; o resto dos `4xx`, definitivo. */
async function call(what: string, url: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new DeliveryError('TRANSIENT', 'UNAVAILABLE', `${what}: ${(err as Error).message}`);
  }
  if (res.status >= 500 || res.status === 429) {
    await res.body?.cancel();
    throw new DeliveryError('TRANSIENT', `HTTP_${res.status}`, `${what} respondeu ${res.status}`);
  }
  return res;
}

/**
 * Destinatário pelo customer-service (`/v1/internal/notification-recipients`, token de serviço com
 * `customer:notification-recipients`). `404` = ninguém a notificar; fora do ar → erro transitório
 * (o consumidor tenta de novo).
 */
export class HttpRecipientDirectory implements RecipientDirectory {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: Pick<ServiceTokenProvider, 'token'>,
  ) {}

  async resolve(ref: RecipientRef): Promise<Recipient | null> {
    const [key, value] = Object.entries(ref)[0]!;
    const url = `${this.baseUrl}/v1/internal/notification-recipients?${key}=${encodeURIComponent(value as string)}`;
    const res = await call('customer-service', url, {
      headers: { authorization: `Bearer ${await this.tokens.token()}` },
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new DeliveryError('TRANSIENT', `HTTP_${res.status}`, 'destinatário indisponível');
    }
    const body = (await res.json()) as Recipient;
    return {
      userId: body.userId,
      accountId: body.accountId,
      email: body.email,
      phone: body.phone,
    };
  }
}

export interface SmtpSettings {
  host: string;
  port: number;
  from: string;
}

/** E-mail por SMTP: no local, o Mailpit (caixa de captura, RN-MSG-001). */
export class SmtpEmailSender implements EmailSender {
  private readonly smtp: Transporter;

  constructor(private readonly s: SmtpSettings) {
    this.smtp = nodemailer.createTransport({ host: s.host, port: s.port, secure: false });
  }

  async send(m: OutgoingEmail): Promise<void> {
    try {
      await this.smtp.sendMail({
        from: this.s.from,
        to: m.to,
        subject: m.subject,
        text: m.text,
        messageId: m.messageId,
      });
    } catch (err) {
      // 5xx do SMTP (destinatário recusado etc.) é definitivo; conexão e 4xx, transitórios.
      const code = (err as { responseCode?: number }).responseCode;
      if (code !== undefined && code >= 500)
        throw new DeliveryError('DEFINITIVE', `SMTP_${code}`, (err as Error).message);
      throw new DeliveryError(
        'TRANSIENT',
        code ? `SMTP_${code}` : 'SMTP_UNAVAILABLE',
        (err as Error).message,
      );
    }
  }

  close(): void {
    this.smtp.close();
  }
}

/** message-sink: SMS e push simulados (RN-MSG-002/003); nada sai para telefone ou aparelho real. */
export class HttpMessageSink implements MessageSinkPort {
  constructor(private readonly baseUrl: string) {}

  private async post(path: string, body: object): Promise<SinkResult> {
    const res = await call('message-sink', `${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new DeliveryError(
        'DEFINITIVE',
        `HTTP_${res.status}`,
        `message-sink recusou (${res.status})`,
      );
    }
    const r = (await res.json()) as SinkResult;
    return { status: r.status, error: r.error };
  }

  sms(m: { to: string; body: string }) {
    return this.post('/v1/sms', { to: m.to, body: m.body });
  }

  push(m: { deviceToken: string; title: string; body: string; data: Record<string, string> }) {
    return this.post('/v1/push', {
      device_token: m.deviceToken,
      title: m.title,
      body: m.body,
      data: m.data,
    });
  }
}

/** Cifra de campo e HMAC do `@broker/persistence` para o token de push (RN-DB-031). */
export class FieldTokenProtection implements TokenProtection {
  constructor(
    private readonly cipher: FieldCipher,
    private readonly index: BlindIndex,
  ) {}

  seal(token: string): string {
    return this.cipher.encrypt(token, 'push_device_token.token');
  }
  open(stored: string): string {
    return this.cipher.decrypt(stored, 'push_device_token.token');
  }
  hash(token: string): string {
    return this.index.hash(token, 'push_device_token.token');
  }
}
