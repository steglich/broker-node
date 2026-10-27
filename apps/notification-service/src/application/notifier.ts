// Evento de origem → notificação (Notificações §3–§4): idempotência, preferências, template por
// canal, "ocultar valores", agrupamento e horário de silêncio.
import {
  catalogEntry,
  effectiveChannels,
  isExternal,
  silenceable,
  type CatalogEntry,
  type Channel,
} from '../domain/catalog.js';
import { releaseAfterQuietHours, RETRY } from '../domain/delivery.js';
import { render, type TemplateVars } from '../domain/template.js';
import { LOCALE, type NotificationDeps } from './context.js';
import type {
  DeliveryRow,
  NotificationRow,
  NotificationTx,
  RecipientRef,
  Settings,
  TemplateRow,
} from './ports.js';

/** O que o consumidor extrai de um evento de origem. */
export interface SourceEvent {
  eventId: string;
  code: string;
  recipient: RecipientRef;
  /** Variáveis do template (valores em texto: decimais, ISO). */
  vars: Record<string, string>;
  /** Identificadores do recurso, que vão em `data` junto com o deep link. */
  data?: Record<string, string>;
  /** Rota do app (RN-FE-050), igual em todos os canais (RN-NOT-G-009). */
  deepLink: string;
}

export type NotifyOutcome = 'CREATED' | 'MERGED' | 'DUPLICATE' | 'DISABLED' | 'NO_RECIPIENT';

/** Título do push com "ocultar valores": nada além do nome do app. */
const HIDDEN_TITLE = 'Broker';

export class Notifier {
  constructor(private readonly d: NotificationDeps) {}

  async notify(
    tx: NotificationTx,
    s: SourceEvent,
  ): Promise<{ outcome: NotifyOutcome; notificationId?: string }> {
    const entry = catalogEntry(s.code);
    if (!entry) throw new Error(`código fora do catálogo: ${s.code}`);
    // RN-NOT-G-004: um par (evento, código) gera no máximo uma notificação (e uma entrega por canal).
    if (!(await tx.claimSource(s.eventId, s.code))) return { outcome: 'DUPLICATE' };

    const recipient = await this.d.recipients.resolve(s.recipient);
    if (!recipient) {
      this.d.logger.warn(
        { event: 'notification.no_recipient', code: s.code, eventId: s.eventId },
        'evento sem destinatário conhecido',
      );
      return { outcome: 'NO_RECIPIENT' };
    }
    const channels = effectiveChannels(entry, await tx.preferences(recipient.userId));
    if (channels.length === 0) return { outcome: 'DISABLED' };

    const now = this.d.clock.now();
    const data: Record<string, string> = { ...s.data, deepLink: s.deepLink };
    if (entry.group) {
      const key = s.vars[entry.group.by] ?? data[entry.group.by];
      const open = key ? await tx.openGroup(recipient.userId, s.code, key, now) : null;
      if (open) {
        await this.merge(tx, entry, open, s.vars, data);
        await tx.linkSource(s.eventId, s.code, open.id);
        return { outcome: 'MERGED', notificationId: open.id };
      }
    }

    const settings = await tx.settings(recipient.userId);
    const templates = await tx.templates(s.code, LOCALE, now);
    const content = this.contents(entry, channels, templates, s.vars, settings);
    const inApp = content.get('IN_APP') ?? content.get(channels[0]!)!;
    const visibleAt = entry.group ? now.plusMillis(entry.group.windowMs) : now;
    const id = this.d.newId();
    const n: NotificationRow = {
      id,
      userId: recipient.userId,
      accountId: recipient.accountId,
      code: s.code,
      title: inApp.title,
      body: inApp.body,
      data,
      priority: entry.priority,
      channels,
      vars: s.vars,
      templateVersion: inApp.version,
      groupKey: entry.group ? (s.vars[entry.group.by] ?? data[entry.group.by] ?? null) : null,
      visibleAt,
      createdPublished: !visibleAt.isAfter(now),
      createdAt: now,
      readAt: null,
    };
    await tx.insertNotification(n);
    await tx.insertDeliveries(
      channels.map((channel): DeliveryRow => {
        const text = content.get(channel)!;
        if (!isExternal(channel))
          return {
            notificationId: id,
            channel,
            status: 'DELIVERED',
            title: text.title,
            body: text.body,
            attempts: 0,
            nextAttemptAt: null,
            deadlineAt: null,
            lastError: null,
            deliveredAt: visibleAt,
          };
        // RN-NOT-G-006: baixa e média em PUSH/EMAIL esperam o fim do silêncio.
        const first = silenceable(entry, channel)
          ? releaseAfterQuietHours(visibleAt, settings.quietHours)
          : visibleAt;
        return {
          notificationId: id,
          channel,
          status: 'PENDING',
          title: text.title,
          body: text.body,
          attempts: 0,
          nextAttemptAt: first,
          deadlineAt: first.plusMillis(RETRY[channel].windowMs),
          lastError: null,
          deliveredAt: null,
        };
      }),
    );
    await tx.linkSource(s.eventId, s.code, id);
    if (n.createdPublished) await publishCreated(tx, n);
    return { outcome: 'CREATED', notificationId: id };
  }

  /** RN-NOT-G-005: o evento novo da mesma ordem atualiza a notificação ainda na janela. */
  private async merge(
    tx: NotificationTx,
    entry: CatalogEntry,
    open: NotificationRow,
    vars: TemplateVars,
    data: Record<string, string>,
  ) {
    const merged = { ...open.vars, ...vars };
    const settings = await tx.settings(open.userId);
    const templates = await tx.templates(open.code, LOCALE, this.d.clock.now());
    const content = this.contents(entry, open.channels, templates, merged, settings);
    const inApp = content.get('IN_APP') ?? content.get(open.channels[0]!)!;
    await tx.updateContent({
      id: open.id,
      title: inApp.title,
      body: inApp.body,
      data: { ...open.data, ...data },
      vars: merged,
    });
    for (const [channel, text] of content)
      await tx.updateDeliveryText(open.id, channel, text.title, text.body);
  }

  private contents(
    entry: CatalogEntry,
    channels: readonly Channel[],
    templates: TemplateRow[],
    vars: TemplateVars,
    settings: Settings,
  ): Map<Channel, { title: string; body: string; version: number }> {
    const out = new Map<Channel, { title: string; body: string; version: number }>();
    for (const channel of channels) {
      const tpl =
        templates.find((t) => t.channel === channel) ?? templates.find((t) => t.channel === 'ANY');
      if (!tpl) throw new Error(`sem template vigente para ${entry.code}/${channel}`);
      // RN-NOT-G-003: com "ocultar valores", o push (tela de bloqueio) só diz que há novidade.
      if (channel === 'PUSH' && settings.hideValues)
        out.set(channel, { title: HIDDEN_TITLE, body: entry.hiddenText, version: tpl.version });
      else
        out.set(channel, {
          title: render(tpl.titleTpl, vars),
          body: render(tpl.bodyTpl, vars),
          version: tpl.version,
        });
    }
    return out;
  }
}

export async function publishCreated(tx: NotificationTx, n: NotificationRow): Promise<void> {
  await tx.publish(
    {
      type: 'notification.created',
      payload: {
        notificationId: n.id,
        userId: n.userId,
        accountId: n.accountId,
        code: n.code,
        title: n.title,
        priority: n.priority,
        channels: n.channels,
        deepLink: n.data['deepLink'] ?? '/notificacoes',
      },
    },
    n.userId,
  );
}
