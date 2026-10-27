import { NotificationCreatedV1 } from '@broker/contracts/events/notification.created/v1';
import { NotificationDeliveredV1 } from '@broker/contracts/events/notification.delivered/v1';
import { NotificationFailedV1 } from '@broker/contracts/events/notification.failed/v1';
import { NotificationReadV1 } from '@broker/contracts/events/notification.read/v1';
import { Instant } from '@broker/domain-kernel';
import type { EventDefinition, EventPublisher } from '@broker/messaging';
import { inTransaction } from '@broker/persistence';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type {
  DeliveryRow,
  DueDelivery,
  NotificationEvent,
  NotificationRow,
  NotificationStore,
  NotificationTx,
  PushDeviceRow,
  TemplateRow,
} from '../application/ports.js';
import type { Channel } from '../domain/catalog.js';

type Row = Record<string, unknown>;

const EVENTS: Record<NotificationEvent['type'], EventDefinition> = {
  'notification.created': NotificationCreatedV1,
  'notification.delivered': NotificationDeliveredV1,
  'notification.failed': NotificationFailedV1,
  'notification.read': NotificationReadV1,
};
const ACTOR = { type: 'SYSTEM' as const, id: 'notification-service' };

const inst = (v: unknown): Instant => Instant.ofEpochMillis((v as Date).getTime());
const instOrNull = (v: unknown): Instant | null => (v ? inst(v) : null);
const ts = (i: Instant | null | undefined) => (i ? i.toString() : null);

const toNotification = (r: Row): NotificationRow => ({
  id: r['id'] as string,
  userId: r['user_id'] as string,
  accountId: (r['account_id'] as string | null) ?? null,
  code: r['code'] as string,
  title: r['title'] as string,
  body: r['body'] as string,
  data: r['data'] as Record<string, string>,
  priority: r['priority'] as NotificationRow['priority'],
  channels: r['channels'] as Channel[],
  vars: r['vars'] as Record<string, string>,
  templateVersion: r['template_version'] as number,
  groupKey: (r['group_key'] as string | null) ?? null,
  visibleAt: inst(r['visible_at']),
  createdPublished: r['created_published'] as boolean,
  createdAt: inst(r['created_at']),
  readAt: instOrNull(r['read_at']),
});

const toDelivery = (r: Row): DeliveryRow => ({
  notificationId: r['notification_id'] as string,
  channel: r['channel'] as Channel,
  status: r['status'] as DeliveryRow['status'],
  title: r['title'] as string,
  body: r['body'] as string,
  attempts: r['attempts'] as number,
  nextAttemptAt: instOrNull(r['next_attempt_at']),
  deadlineAt: instOrNull(r['deadline_at']),
  lastError: (r['last_error'] as string | null) ?? null,
  deliveredAt: instOrNull(r['delivered_at']),
});

const toDevice = (r: Row): PushDeviceRow => ({
  id: r['id'] as string,
  userId: r['user_id'] as string,
  platform: r['platform'] as PushDeviceRow['platform'],
  tokenEnc: r['token_enc'] as string,
  tokenHash: r['token_hash'] as string,
  status: r['status'] as PushDeviceRow['status'],
  lastSeenAt: inst(r['last_seen_at']),
});

/** Persistência do notification-service (Kysely + pg) com a outbox na mesma transação. */
export class PostgresNotificationStore implements NotificationStore {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly publisher: EventPublisher,
  ) {}

  transaction<T>(fn: (tx: NotificationTx) => Promise<T>): Promise<T> {
    return inTransaction(this.db, (trx) => fn(this.tx(trx)));
  }

  /** Unidade de trabalho sobre uma transação já aberta (ex.: a do consumidor, com a inbox). */
  tx(trx: Kysely<unknown>): NotificationTx {
    const publisher = this.publisher;
    const one = async <T>(q: RawBuilder<Row>, map: (r: Row) => T): Promise<T | null> => {
      const row = (await q.execute(trx)).rows[0];
      return row ? map(row) : null;
    };
    const many = async <T>(q: RawBuilder<Row>, map: (r: Row) => T): Promise<T[]> =>
      (await q.execute(trx)).rows.map(map);

    return {
      templates: (code, locale, at) =>
        many(
          sql<Row>`
            SELECT DISTINCT ON (channel) * FROM notification_template
            WHERE code = ${code} AND locale = ${locale} AND valid_from <= ${at.toString()}
            ORDER BY channel, version DESC`,
          (r): TemplateRow => ({
            code: r['code'] as string,
            channel: r['channel'] as TemplateRow['channel'],
            version: r['version'] as number,
            locale: r['locale'] as string,
            titleTpl: r['title_tpl'] as string,
            bodyTpl: r['body_tpl'] as string,
          }),
        ),

      async claimSource(eventId, code) {
        const { rows } = await sql`
          INSERT INTO notification_source (source_event_id, code) VALUES (${eventId}, ${code})
          ON CONFLICT DO NOTHING RETURNING code`.execute(trx);
        return rows.length === 1;
      },
      async linkSource(eventId, code, notificationId) {
        await sql`
          UPDATE notification_source SET notification_id = ${notificationId}
          WHERE source_event_id = ${eventId} AND code = ${code}`.execute(trx);
      },
      openGroup: (userId, code, groupKey, at) =>
        one(
          sql<Row>`
            SELECT * FROM notification
            WHERE user_id = ${userId} AND code = ${code} AND group_key = ${groupKey}
              AND visible_at > ${at.toString()}
            ORDER BY visible_at DESC LIMIT 1 FOR UPDATE`,
          toNotification,
        ),
      async insertNotification(n) {
        await sql`
          INSERT INTO notification (id, user_id, account_id, code, title, body, data, priority, channels,
            vars, template_version, group_key, visible_at, created_published, created_at, read_at)
          VALUES (${n.id}, ${n.userId}, ${n.accountId}, ${n.code}, ${n.title}, ${n.body},
            ${JSON.stringify(n.data)}, ${n.priority}, ${n.channels}::text[], ${JSON.stringify(n.vars)},
            ${n.templateVersion}, ${n.groupKey}, ${n.visibleAt.toString()}, ${n.createdPublished},
            ${n.createdAt.toString()}, ${ts(n.readAt)})`.execute(trx);
      },
      async updateContent(n) {
        await sql`
          UPDATE notification SET title = ${n.title}, body = ${n.body}, data = ${JSON.stringify(n.data)},
            vars = ${JSON.stringify(n.vars)}
          WHERE id = ${n.id}`.execute(trx);
      },
      notification: (id) =>
        one(sql<Row>`SELECT * FROM notification WHERE id = ${id}`, toNotification),
      async insertDeliveries(rows) {
        for (const d of rows)
          await sql`
            INSERT INTO notification_delivery (notification_id, channel, status, title, body, attempts,
              next_attempt_at, deadline_at, last_error, delivered_at)
            VALUES (${d.notificationId}, ${d.channel}, ${d.status}, ${d.title}, ${d.body}, ${d.attempts},
              ${ts(d.nextAttemptAt)}, ${ts(d.deadlineAt)}, ${d.lastError}, ${ts(d.deliveredAt)})
            ON CONFLICT DO NOTHING`.execute(trx);
      },
      async updateDeliveryText(notificationId, channel, title, body) {
        await sql`
          UPDATE notification_delivery SET title = ${title}, body = ${body}
          WHERE notification_id = ${notificationId} AND channel = ${channel}`.execute(trx);
      },
      deliveries: (id) =>
        many(
          sql<Row>`SELECT * FROM notification_delivery WHERE notification_id = ${id} ORDER BY channel`,
          toDelivery,
        ),

      async settings(userId) {
        const r = (
          await sql<Row>`SELECT * FROM notification_settings WHERE user_id = ${userId}`.execute(trx)
        ).rows[0];
        return {
          quietHours:
            r && r['quiet_start']
              ? { start: r['quiet_start'] as string, end: r['quiet_end'] as string }
              : null,
          hideValues: (r?.['hide_values'] as boolean | undefined) ?? false,
        };
      },
      async saveSettings(userId, s) {
        await sql`
          INSERT INTO notification_settings (user_id, quiet_start, quiet_end, hide_values, updated_at)
          VALUES (${userId}, ${s.quietHours?.start ?? null}, ${s.quietHours?.end ?? null}, ${s.hideValues}, now())
          ON CONFLICT (user_id) DO UPDATE SET quiet_start = EXCLUDED.quiet_start,
            quiet_end = EXCLUDED.quiet_end, hide_values = EXCLUDED.hide_values, updated_at = now()`.execute(
          trx,
        );
      },
      async preferences(userId) {
        const rows = (
          await sql<Row>`SELECT code, channel, enabled FROM notification_preference WHERE user_id = ${userId}`.execute(
            trx,
          )
        ).rows;
        const map = new Map<string, Map<Channel, boolean>>();
        for (const r of rows) {
          const code = r['code'] as string;
          if (!map.has(code)) map.set(code, new Map());
          map.get(code)!.set(r['channel'] as Channel, r['enabled'] as boolean);
        }
        return map;
      },
      async savePreference(userId, code, channel, enabled) {
        await sql`
          INSERT INTO notification_preference (user_id, code, channel, enabled, updated_at)
          VALUES (${userId}, ${code}, ${channel}, ${enabled}, now())
          ON CONFLICT (user_id, code, channel) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`.execute(
          trx,
        );
      },

      listInApp: (userId, at, page, unreadOnly) => {
        const cursor = page.cursor
          ? sql`AND (visible_at, id) < (${page.cursor.value}::timestamptz, ${page.cursor.id}::uuid)`
          : sql``;
        return many(
          sql<Row>`
            SELECT * FROM notification
            WHERE user_id = ${userId} AND 'IN_APP' = ANY (channels) AND visible_at <= ${at.toString()}
              ${unreadOnly ? sql`AND read_at IS NULL` : sql``} ${cursor}
            ORDER BY visible_at DESC, id DESC LIMIT ${page.limit + 1}`,
          toNotification,
        );
      },
      async unreadCount(userId, at) {
        const r = (
          await sql<{ n: string }>`
            SELECT count(*) AS n FROM notification
            WHERE user_id = ${userId} AND 'IN_APP' = ANY (channels) AND visible_at <= ${at.toString()}
              AND read_at IS NULL`.execute(trx)
        ).rows[0]!;
        return Number(r.n);
      },
      async markRead(userId, ids, at) {
        const filter = ids ? sql`AND id = ANY (${ids}::uuid[])` : sql``;
        const { rows } = await sql<{ id: string }>`
          UPDATE notification SET read_at = ${at.toString()}
          WHERE user_id = ${userId} AND read_at IS NULL AND 'IN_APP' = ANY (channels)
            AND visible_at <= ${at.toString()} ${filter}
          RETURNING id`.execute(trx);
        return rows.map((r) => r.id).sort();
      },

      claimDue: (at, leaseMs, limit) =>
        many(
          sql<Row>`
            WITH due AS (
              SELECT d.notification_id, d.channel FROM notification_delivery d
              WHERE d.status = 'PENDING' AND d.next_attempt_at <= ${at.toString()}
              ORDER BY d.next_attempt_at LIMIT ${limit}
              FOR UPDATE SKIP LOCKED
            )
            UPDATE notification_delivery d
            SET next_attempt_at = ${at.plusMillis(leaseMs).toString()}
            FROM due, notification n
            WHERE d.notification_id = due.notification_id AND d.channel = due.channel
              AND n.id = d.notification_id
            RETURNING d.*, n.user_id, n.code, n.data`,
          (r): DueDelivery => ({
            ...toDelivery(r),
            channel: r['channel'] as DueDelivery['channel'],
            userId: r['user_id'] as string,
            code: r['code'] as string,
            data: r['data'] as Record<string, string>,
          }),
        ),
      async saveDelivery(d) {
        await sql`
          UPDATE notification_delivery SET status = ${d.status}, attempts = ${d.attempts},
            next_attempt_at = ${ts(d.nextAttemptAt)}, last_error = ${d.lastError},
            delivered_at = ${ts(d.deliveredAt)}
          WHERE notification_id = ${d.notificationId} AND channel = ${d.channel}`.execute(trx);
      },
      takeReleased: (at, limit) =>
        many(
          sql<Row>`
            WITH due AS (
              SELECT id FROM notification
              WHERE NOT created_published AND visible_at <= ${at.toString()}
              ORDER BY visible_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
            )
            UPDATE notification n SET created_published = true FROM due WHERE n.id = due.id
            RETURNING n.*`,
          toNotification,
        ),
      async purge(before, limit) {
        const { rows } = await sql`
          WITH old AS (
            SELECT id FROM notification WHERE created_at < ${before.toString()} LIMIT ${limit}
          )
          DELETE FROM notification n USING old WHERE n.id = old.id RETURNING n.id`.execute(trx);
        await sql`
          DELETE FROM notification_source WHERE ctid IN (
            SELECT ctid FROM notification_source WHERE created_at < ${before.toString()} LIMIT ${limit})`.execute(
          trx,
        );
        return rows.length;
      },

      pushDevices: (userId) =>
        many(
          sql<Row>`
            SELECT * FROM push_device_token WHERE user_id = ${userId} AND status = 'ACTIVE'
            ORDER BY last_seen_at DESC`,
          toDevice,
        ),
      deviceByHash: (hash) =>
        one(
          sql<Row>`SELECT * FROM push_device_token WHERE token_hash = ${hash} FOR UPDATE`,
          toDevice,
        ),
      async upsertDevice(d) {
        await sql`
          INSERT INTO push_device_token (id, user_id, platform, token_enc, token_hash, status, last_seen_at)
          VALUES (${d.id}, ${d.userId}, ${d.platform}, ${d.tokenEnc}, ${d.tokenHash}, ${d.status},
            ${d.lastSeenAt.toString()})
          ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
            token_enc = EXCLUDED.token_enc, status = EXCLUDED.status, last_seen_at = EXCLUDED.last_seen_at`.execute(
          trx,
        );
      },
      async markDeviceUnregistered(id) {
        await sql`UPDATE push_device_token SET status = 'UNREGISTERED' WHERE id = ${id}`.execute(
          trx,
        );
      },

      async publish(event, partitionKey) {
        await publisher.publish(trx, EVENTS[event.type], event.payload as never, {
          partitionKey,
          aggregateType: 'notification',
          aggregateId: partitionKey,
          actor: ACTOR,
        });
      },
    };
  }
}
