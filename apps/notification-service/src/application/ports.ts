import type { Instant } from '@broker/domain-kernel';
import type { PageQuery } from '@broker/service-kit';
import type { Channel, ExternalChannel, PreferenceMap, Priority } from '../domain/catalog.js';
import type { QuietHours } from '../domain/delivery.js';
import type { TemplateVars } from '../domain/template.js';

export interface TemplateRow {
  code: string;
  /** `ANY` vale para os canais sem template próprio. */
  channel: Channel | 'ANY';
  version: number;
  locale: string;
  titleTpl: string;
  bodyTpl: string;
}

export interface NotificationRow {
  id: string;
  userId: string;
  accountId: string | null;
  code: string;
  title: string;
  body: string;
  /** Deep link e identificadores do recurso (RN-NOT-G-009). */
  data: Record<string, string>;
  priority: Priority;
  channels: Channel[];
  /** Variáveis do template, para re-renderizar no agrupamento. */
  vars: Record<string, string>;
  templateVersion: number;
  groupKey: string | null;
  /** Fim da janela de agrupamento; até lá a notificação não aparece nem sai. */
  visibleAt: Instant;
  createdPublished: boolean;
  createdAt: Instant;
  readAt: Instant | null;
}

export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED' | 'SKIPPED';

export interface DeliveryRow {
  notificationId: string;
  channel: Channel;
  status: DeliveryStatus;
  title: string;
  body: string;
  attempts: number;
  nextAttemptAt: Instant | null;
  deadlineAt: Instant | null;
  lastError: string | null;
  deliveredAt: Instant | null;
}

/** Entrega reservada pelo laço: o que é preciso para enviar sem reler a notificação. */
export interface DueDelivery extends DeliveryRow {
  channel: ExternalChannel;
  userId: string;
  code: string;
  data: Record<string, string>;
}

export interface Settings {
  quietHours: QuietHours | null;
  hideValues: boolean;
}

export interface PushDeviceRow {
  id: string;
  userId: string;
  platform: 'IOS' | 'ANDROID';
  tokenEnc: string;
  tokenHash: string;
  status: 'ACTIVE' | 'UNREGISTERED';
  lastSeenAt: Instant;
}

export type NotificationEvent =
  | {
      type: 'notification.created';
      payload: {
        notificationId: string;
        userId: string;
        accountId: string | null;
        code: string;
        title: string;
        priority: Priority;
        channels: Channel[];
        deepLink: string;
      };
    }
  | {
      type: 'notification.delivered';
      payload: {
        notificationId: string;
        userId: string;
        code: string;
        channel: ExternalChannel;
        attempts: number;
        deliveredAt: string;
      };
    }
  | {
      type: 'notification.failed';
      payload: {
        notificationId: string;
        userId: string;
        code: string;
        channel: ExternalChannel;
        attempts: number;
        reason: string;
      };
    }
  | {
      type: 'notification.read';
      payload: { userId: string; notificationIds: string[]; readAt: string };
    };

export interface NotificationTx {
  /** A versão vigente de cada canal do código (a maior com `valid_from` até `at`). */
  templates(code: string, locale: string, at: Instant): Promise<TemplateRow[]>;

  /** Reserva o par (evento, código): `false` se já foi tratado (RN-NOT-G-004). */
  claimSource(eventId: string, code: string): Promise<boolean>;
  /** Liga o par reservado à notificação que ele gerou (ou na qual foi agrupado). */
  linkSource(eventId: string, code: string, notificationId: string): Promise<void>;
  /** Notificação do mesmo grupo ainda dentro da janela (RN-NOT-G-005). */
  openGroup(
    userId: string,
    code: string,
    groupKey: string,
    at: Instant,
  ): Promise<NotificationRow | null>;
  insertNotification(n: NotificationRow): Promise<void>;
  updateContent(n: Pick<NotificationRow, 'id' | 'title' | 'body' | 'data' | 'vars'>): Promise<void>;
  notification(id: string): Promise<NotificationRow | null>;
  insertDeliveries(rows: DeliveryRow[]): Promise<void>;
  updateDeliveryText(
    notificationId: string,
    channel: Channel,
    title: string,
    body: string,
  ): Promise<void>;
  deliveries(notificationId: string): Promise<DeliveryRow[]>;

  settings(userId: string): Promise<Settings>;
  saveSettings(userId: string, s: Settings): Promise<void>;
  preferences(userId: string): Promise<PreferenceMap>;
  savePreference(userId: string, code: string, channel: Channel, enabled: boolean): Promise<void>;

  /** Central in-app: só as visíveis, com o canal IN_APP. */
  listInApp(
    userId: string,
    at: Instant,
    page: PageQuery,
    unreadOnly: boolean,
  ): Promise<NotificationRow[]>;
  unreadCount(userId: string, at: Instant): Promise<number>;
  /** Marca como lidas e devolve as que mudaram. `ids = null` marca todas. */
  markRead(userId: string, ids: string[] | null, at: Instant): Promise<string[]>;

  /** Reserva entregas vencidas (SKIP LOCKED) e adia a próxima tentativa por `leaseMs`. */
  claimDue(at: Instant, leaseMs: number, limit: number): Promise<DueDelivery[]>;
  saveDelivery(d: DeliveryRow): Promise<void>;
  /** Notificações agrupadas cuja janela fechou e que ainda não publicaram `notification.created`. */
  takeReleased(at: Instant, limit: number): Promise<NotificationRow[]>;
  /** RN-NOT-G-008: apaga as criadas antes de `before`. */
  purge(before: Instant, limit: number): Promise<number>;

  pushDevices(userId: string): Promise<PushDeviceRow[]>;
  deviceByHash(tokenHash: string): Promise<PushDeviceRow | null>;
  upsertDevice(d: PushDeviceRow): Promise<void>;
  markDeviceUnregistered(id: string): Promise<void>;

  publish(event: NotificationEvent, partitionKey: string): Promise<void>;
}

export interface NotificationStore {
  transaction<T>(fn: (tx: NotificationTx) => Promise<T>): Promise<T>;
}

/** Referência do destinatário no evento de origem: exatamente uma. */
export type RecipientRef =
  { userId: string } | { customerId: string } | { accountId: string } | { applicationId: string };

export interface Recipient {
  userId: string;
  accountId: string | null;
  email: string | null;
  phone: string | null;
}

/** Destinatários e contato atual (customer-service); `null` = ninguém a notificar. */
export interface RecipientDirectory {
  resolve(ref: RecipientRef): Promise<Recipient | null>;
}

/** Falha de entrega: `TRANSIENT` volta para a fila; `DEFINITIVE` encerra o canal. */
export class DeliveryError extends Error {
  override readonly name = 'DeliveryError';
  constructor(
    readonly kind: 'TRANSIENT' | 'DEFINITIVE',
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  /** Message-ID estável: o mesmo e-mail reenviado é reconhecível na caixa. */
  messageId: string;
}

export interface EmailSender {
  send(m: OutgoingEmail): Promise<void>;
}

export interface SinkResult {
  status: 'DELIVERED' | 'FAILED';
  error: string | null;
}

/** message-sink: SMS e push simulados (Sistemas simulados §4). */
export interface MessageSinkPort {
  sms(m: { to: string; body: string }): Promise<SinkResult>;
  push(m: {
    deviceToken: string;
    title: string;
    body: string;
    data: Record<string, string>;
  }): Promise<SinkResult>;
}

/** Cifra e HMAC do token de push (RN-DB-031). */
export interface TokenProtection {
  seal(token: string): string;
  open(stored: string): string;
  hash(token: string): string;
}

export type { TemplateVars };
