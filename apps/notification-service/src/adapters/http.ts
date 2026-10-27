import { notificationServiceHttp } from '@broker/contracts/http/notification-service';
import {
  HttpError,
  parsePageQuery,
  type HandlerResult,
  type RouteDefinition,
  type Service,
} from '@broker/service-kit';
import type { TSchema } from 'typebox';
import type {
  NotificationCenter,
  Preferences,
  PreferencesInput,
  PushDevices,
} from '../application/center.js';
import { NotificationError } from '../application/context.js';

const r = notificationServiceHttp.routes;

export interface HttpDeps {
  center: NotificationCenter;
  preferences: Preferences;
  devices: PushDevices;
}

function toHttp(err: unknown): never {
  if (err instanceof NotificationError)
    throw new HttpError(err.status, err.code, err.message, {
      ...(err.status === 422 ? { title: err.message } : {}),
    });
  throw err;
}

const USER = { principal: 'user' as const };

export function registerHttp(service: Service, d: HttpDeps): void {
  const run = async (fn: () => Promise<HandlerResult>) => {
    try {
      return await fn();
    } catch (err) {
      toHttp(err);
    }
  };
  const route = <
    SB extends TSchema | undefined = undefined,
    SQ extends TSchema | undefined = undefined,
    SP extends TSchema | undefined = undefined,
  >(
    def: RouteDefinition<SB, SQ, SP>,
  ) => service.route<SB, SQ, SP>({ idempotent: false, ...def });

  route({
    method: 'get',
    path: '/v1/me/notifications',
    auth: USER,
    validate: { query: r.list.query },
    handler: (q, ctx) =>
      run(async () => {
        const page = parsePageQuery(q.query, {
          sortable: { createdAt: 'visible_at' },
          defaultSort: '-createdAt',
        });
        return { body: await d.center.list(ctx.actor.id, page, q.query.unread === 'true') };
      }),
  });
  route({
    method: 'post',
    path: '/v1/me/notifications/read',
    auth: USER,
    validate: { body: r.markRead.body },
    handler: (q, ctx) =>
      run(async () => {
        const body = q.body as { ids?: string[]; all?: true };
        return { body: await d.center.markRead(ctx.actor.id, body.all ? null : body.ids!) };
      }),
  });
  route({
    method: 'get',
    path: '/v1/me/notification-preferences',
    auth: USER,
    handler: (_q, ctx) => run(async () => ({ body: await d.preferences.get(ctx.actor.id) })),
  });
  route({
    method: 'put',
    path: '/v1/me/notification-preferences',
    auth: USER,
    validate: { body: r.putPreferences.body },
    handler: (q, ctx) =>
      run(async () => ({
        body: await d.preferences.put(ctx.actor.id, q.body as PreferencesInput),
      })),
  });
  route({
    method: 'post',
    path: '/v1/me/push-devices',
    auth: USER,
    validate: { body: r.registerPushDevice.body },
    handler: (q, ctx) =>
      run(async () => {
        const { id, created } = await d.devices.register(ctx.actor.id, q.body);
        return { status: created ? 201 : 200, body: { id } };
      }),
  });
}
