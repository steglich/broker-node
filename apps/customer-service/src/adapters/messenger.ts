import { randomUUID } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Messenger } from '../application/ports.js';

export interface MessengerSettings {
  smtpHost: string;
  smtpPort: number;
  from: string;
  /** message-sink (SMS simulado, Sistemas simulados §4). */
  smsUrl: string;
}

/**
 * Códigos de verificação (OTP do onboarding e das trocas de contato): saem direto do customer-service,
 * sem passar pelo barramento. E-mail por SMTP (Mailpit) e SMS pelo message-sink.
 */
export class SmtpAndSinkMessenger implements Messenger {
  private readonly smtp: Transporter;

  constructor(private readonly s: MessengerSettings) {
    this.smtp = nodemailer.createTransport({ host: s.smtpHost, port: s.smtpPort, secure: false });
  }

  async email(to: string, subject: string, text: string): Promise<void> {
    await this.smtp.sendMail({ from: this.s.from, to, subject, text });
  }

  async sms(to: string, text: string): Promise<void> {
    const res = await fetch(`${this.s.smsUrl}/v1/sms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ to, body: text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`message-sink respondeu HTTP ${res.status}`);
  }

  close(): void {
    this.smtp.close();
  }
}
