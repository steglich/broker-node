import type { Clock } from '@broker/clock';
import { notFound } from '@broker/service-kit';
import type { SimulatorControl } from '@broker/simulator-kit';
import { sql, type Kysely } from 'kysely';

export type SinkScenario = 'SMS_FAILURE' | 'PUSH_UNREGISTERED';

export const SINK_SCENARIOS: ReadonlyArray<{ id: SinkScenario; label: string }> = [
  { id: 'SMS_FAILURE', label: 'Próximo SMS: falha de entrega (CARRIER_REJECTED)' },
  { id: 'PUSH_UNREGISTERED', label: 'Próximo push: aparelho não registrado (UNREGISTERED_DEVICE)' },
];

interface MessageRow {
  id: string;
  channel: 'SMS' | 'PUSH';
  recipient: string;
  title: string | null;
  body: string;
  data: Record<string, string>;
  status: 'DELIVERED' | 'FAILED';
  error: string | null;
  created_at: Date;
}

/**
 * Registra SMS e push no lugar da operadora e do serviço de push (RN-MSG-001/002). Cada envio fica
 * com o status de entrega (RN-MSG-003), que a central de notificações consulta.
 */
export class MessageSink {
  constructor(
    private readonly o: {
      db: Kysely<unknown>;
      clock: Clock;
      control: SimulatorControl<SinkScenario>;
      newId: () => string;
    },
  ) {}

  async sms(input: { to: string; body: string }) {
    const failed = this.o.control.consume('SMS_FAILURE');
    return this.record('SMS', input.to, null, input.body, {}, failed ? 'CARRIER_REJECTED' : null);
  }

  async push(input: {
    device_token: string;
    title: string;
    body: string;
    data?: Record<string, string>;
  }) {
    const failed = this.o.control.consume('PUSH_UNREGISTERED');
    return this.record(
      'PUSH',
      input.device_token,
      input.title,
      input.body,
      input.data ?? {},
      failed ? 'UNREGISTERED_DEVICE' : null,
    );
  }

  async get(id: string) {
    const row = (await sql<MessageRow>`SELECT * FROM message WHERE id = ${id}`.execute(this.o.db))
      .rows[0];
    if (!row) throw notFound('Mensagem inexistente.');
    return view(row);
  }

  async list(filter: { channel?: 'SMS' | 'PUSH'; to?: string; limit?: number } = {}) {
    const { rows } = await sql<MessageRow>`
      SELECT * FROM message
      WHERE (${filter.channel ?? null}::text IS NULL OR channel = ${filter.channel ?? null})
        AND (${filter.to ?? null}::text IS NULL OR recipient = ${filter.to ?? null})
      ORDER BY created_at DESC, id DESC LIMIT ${filter.limit ?? 200}`.execute(this.o.db);
    return rows.map(view);
  }

  private async record(
    channel: 'SMS' | 'PUSH',
    to: string,
    title: string | null,
    body: string,
    data: Record<string, string>,
    error: string | null,
  ) {
    const id = this.o.newId();
    const status = error ? 'FAILED' : 'DELIVERED';
    await sql`
      INSERT INTO message (id, channel, recipient, title, body, data, status, error, created_at)
      VALUES (${id}, ${channel}, ${to}, ${title}, ${body}, ${JSON.stringify(data)}, ${status}, ${error},
              ${this.o.clock.now().toString()})`.execute(this.o.db);
    return { message_id: id, status, error } as const;
  }
}

function view(row: MessageRow) {
  return {
    message_id: row.id,
    channel: row.channel,
    to: row.recipient,
    title: row.title,
    body: row.body,
    data: row.data,
    status: row.status,
    error: row.error,
    created_at: row.created_at.toISOString(),
  };
}
