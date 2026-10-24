import type { Clock } from '@broker/clock';
import { messageSinkHttp } from '@broker/contracts/http/message-sink';
import { createService, type BaseConfig, type Logger } from '@broker/service-kit';
import {
  controlSection,
  html,
  page,
  registerControlRoutes,
  SimulatorControl,
  table,
  type Behavior,
} from '@broker/simulator-kit';
import { sql, type Kysely } from 'kysely';
import { MessageSink, SINK_SCENARIOS, type SinkScenario } from './sink.js';

const r = messageSinkHttp.routes;

export interface MessageSinkDeps {
  config: BaseConfig;
  db: Kysely<unknown>;
  clock: Clock;
  logger: Logger;
  behavior: Behavior;
  newId: () => string;
  random?: () => number;
  /** Link da caixa de e-mail (Mailpit) mostrado na UI. */
  mailboxUrl?: string;
}

export function createMessageSink(deps: MessageSinkDeps) {
  const control = new SimulatorControl<SinkScenario>(deps.behavior, deps.clock, deps.random);
  const sink = new MessageSink({ db: deps.db, clock: deps.clock, control, newId: deps.newId });
  const service = createService({
    config: deps.config,
    clock: deps.clock,
    logger: deps.logger,
    readiness: { database: () => sql`SELECT 1`.execute(deps.db) },
  });
  registerControlRoutes(service, control, SINK_SCENARIOS);

  service.route({
    method: 'get',
    path: '/ui',
    auth: 'public',
    handler: async () => {
      const messages = await sink.list();
      const section = (channel: 'SMS' | 'PUSH', title: string) =>
        html`<section>
          <h2>${title}</h2>
          ${table(
            [
              'Recebida',
              'Destinatário',
              ...(channel === 'PUSH' ? ['Título'] : []),
              'Mensagem',
              'Status',
            ],
            messages
              .filter((m) => m.channel === channel)
              .map((m) => [
                m.created_at,
                html`<code>${m.to}</code>`,
                ...(channel === 'PUSH' ? [m.title] : []),
                m.body,
                m.error ? `${m.status} (${m.error})` : m.status,
              ]),
          )}
        </section>`;
      const body = html` <section>
          <p>
            SMS e push ficam só aqui (RN-MSG-001/002).
            ${deps.mailboxUrl ? html`E-mails ficam na caixa de captura: <a href="${deps.mailboxUrl}">${deps.mailboxUrl}</a>.` : ''}
          </p>
        </section>
        ${controlSection(control, SINK_SCENARIOS)} ${section('SMS', 'SMS')}
        ${section('PUSH', 'Push')}`;
      return { type: 'text/html', body: page('Caixa de SMS e push', body) };
    },
  });

  service.use(control.middleware());
  service.route({
    method: 'post',
    path: '/v1/sms',
    auth: 'public',
    idempotent: false,
    validate: { body: r.sendSms.body },
    handler: async (req) => ({ status: 202, body: await sink.sms(req.body) }),
  });
  service.route({
    method: 'post',
    path: '/v1/push',
    auth: 'public',
    idempotent: false,
    validate: { body: r.sendPush.body },
    handler: async (req) => ({ status: 202, body: await sink.push(req.body) }),
  });
  service.route({
    method: 'get',
    path: '/v1/messages/:message_id',
    auth: 'public',
    validate: { params: r.getMessage.params },
    handler: async (req) => ({ body: await sink.get(req.params.message_id) }),
  });
  service.route({
    method: 'get',
    path: '/v1/messages',
    auth: 'public',
    validate: { query: r.listMessages.query },
    handler: async (req) => ({ body: { messages: await sink.list(req.query) } }),
  });
  return { service, sink, control };
}
