// Central in-app, preferências e tokens de push (Contratos §8, catálogo de serviços §17).
import { toPage, type PageQuery } from '@broker/service-kit';
import { CATALOG, catalogEntry, effectiveChannels, type Channel } from '../domain/catalog.js';
import type { QuietHours } from '../domain/delivery.js';
import { NotificationError, type NotificationDeps } from './context.js';
import type { NotificationRow } from './ports.js';

export const toView = (n: NotificationRow) => ({
  id: n.id,
  code: n.code,
  title: n.title,
  body: n.body,
  data: n.data,
  priority: n.priority,
  channels: n.channels,
  createdAt: n.visibleAt.toString(),
  readAt: n.readAt?.toString() ?? null,
});

export class NotificationCenter {
  constructor(private readonly d: NotificationDeps) {}

  async list(userId: string, page: PageQuery, unreadOnly: boolean) {
    const now = this.d.clock.now();
    return this.d.store.transaction(async (tx) => {
      const rows = await tx.listInApp(userId, now, page, unreadOnly);
      const p = toPage(rows, page, (n) => ({ value: n.visibleAt.toString(), id: n.id }));
      return {
        items: p.items.map(toView),
        ...(p.nextCursor ? { nextCursor: p.nextCursor } : {}),
        unreadCount: await tx.unreadCount(userId, now),
      };
    });
  }

  async markRead(userId: string, ids: string[] | null): Promise<{ updated: number }> {
    const now = this.d.clock.now();
    return this.d.store.transaction(async (tx) => {
      const changed = await tx.markRead(userId, ids, now);
      if (changed.length > 0)
        await tx.publish(
          {
            type: 'notification.read',
            payload: { userId, notificationIds: changed, readAt: now.toString() },
          },
          userId,
        );
      return { updated: changed.length };
    });
  }
}

export interface PreferencesInput {
  preferences?: { code: string; channel?: Channel; enabled: boolean }[];
  quietHours?: QuietHours | null;
  hideValues?: boolean;
}

export class Preferences {
  constructor(private readonly d: NotificationDeps) {}

  async get(userId: string) {
    return this.d.store.transaction(async (tx) => {
      const prefs = await tx.preferences(userId);
      const settings = await tx.settings(userId);
      return {
        items: [...CATALOG.values()].map((entry) => {
          const enabled = new Set(effectiveChannels(entry, prefs));
          return {
            code: entry.code,
            priority: entry.priority,
            canDisable: entry.canDisable,
            channels: entry.channels.map((channel) => ({ channel, enabled: enabled.has(channel) })),
          };
        }),
        quietHours: settings.quietHours,
        hideValues: settings.hideValues,
      };
    });
  }

  async put(userId: string, input: PreferencesInput) {
    for (const p of input.preferences ?? []) {
      const entry = catalogEntry(p.code);
      if (!entry)
        throw new NotificationError(
          422,
          'UNKNOWN_NOTIFICATION_CODE',
          `Código desconhecido: ${p.code}.`,
        );
      // Notificações §3: as obrigatórias ignoram a preferência, então nem a aceitamos.
      if (!entry.canDisable)
        throw new NotificationError(
          422,
          'NOTIFICATION_NOT_OPTIONAL',
          `A notificação ${p.code} é obrigatória e não pode ser alterada.`,
        );
      if (p.channel && !entry.channels.includes(p.channel))
        throw new NotificationError(
          422,
          'CHANNEL_NOT_AVAILABLE',
          `A notificação ${p.code} não sai pelo canal ${p.channel}.`,
        );
    }
    await this.d.store.transaction(async (tx) => {
      for (const p of input.preferences ?? []) {
        const channels = p.channel ? [p.channel] : catalogEntry(p.code)!.channels;
        for (const channel of channels) await tx.savePreference(userId, p.code, channel, p.enabled);
      }
      if (input.quietHours !== undefined || input.hideValues !== undefined) {
        const current = await tx.settings(userId);
        await tx.saveSettings(userId, {
          quietHours: input.quietHours !== undefined ? input.quietHours : current.quietHours,
          hideValues: input.hideValues ?? current.hideValues,
        });
      }
    });
    return this.get(userId);
  }
}

export class PushDevices {
  constructor(private readonly d: NotificationDeps) {}

  /** Registra o token (cifrado); o mesmo token de novo renova e passa para o usuário atual. */
  async register(
    userId: string,
    input: { platform: 'IOS' | 'ANDROID'; token: string },
  ): Promise<{ id: string; created: boolean }> {
    const hash = this.d.tokens.hash(input.token);
    const now = this.d.clock.now();
    return this.d.store.transaction(async (tx) => {
      const existing = await tx.deviceByHash(hash);
      const id = existing?.id ?? this.d.newId();
      await tx.upsertDevice({
        id,
        userId,
        platform: input.platform,
        tokenEnc: this.d.tokens.seal(input.token),
        tokenHash: hash,
        status: 'ACTIVE',
        lastSeenAt: now,
      });
      return { id, created: !existing };
    });
  }
}
