import type { Clock } from '@broker/clock';
import type { Logger } from '@broker/service-kit';
import type {
  EmailSender,
  MessageSinkPort,
  NotificationStore,
  RecipientDirectory,
  TokenProtection,
} from './ports.js';

export interface NotificationDeps {
  store: NotificationStore;
  clock: Clock;
  logger: Logger;
  newId: () => string;
  recipients: RecipientDirectory;
  email: EmailSender;
  sink: MessageSinkPort;
  tokens: TokenProtection;
  /** Base dos deep links nos e-mails (`https://app.broker.localhost`). */
  appUrl: string;
}

/** Erro de aplicação com status HTTP e código estável (Problem Details). */
export class NotificationError extends Error {
  override readonly name = 'NotificationError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Retenção da central in-app (RN-NOT-G-008). */
export const RETENTION_MS = 90 * 24 * 3_600_000;
export const LOCALE = 'pt-BR';
