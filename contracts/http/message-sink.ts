// "Gateway" de SMS e push simulado (Sistemas simulados §4, RN-MSG-001..003): nada sai para um
// telefone ou aparelho real; cada mensagem fica registrada com o status de entrega e aparece na UI.
// E-mail não passa por aqui: vai por SMTP para o Mailpit (caixa de captura).
import Type from 'typebox';
import { defineHttpContract } from '../src/define.js';

export const DeliveryStatus = Type.Union([Type.Literal('DELIVERED'), Type.Literal('FAILED')]);

export const SendSms = Type.Object({
  /** E.164: `+5511987654321`. */
  to: Type.String({ pattern: '^\\+[1-9]\\d{7,14}$' }),
  body: Type.String({ minLength: 1, maxLength: 1600 }),
});

export const SendPush = Type.Object({
  device_token: Type.String({ minLength: 8, maxLength: 4096 }),
  title: Type.String({ minLength: 1, maxLength: 120 }),
  body: Type.String({ minLength: 1, maxLength: 1000 }),
  data: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const Message = Type.Object({
  message_id: Type.String({ format: 'uuid' }),
  channel: Type.Union([Type.Literal('SMS'), Type.Literal('PUSH')]),
  to: Type.String(),
  title: Type.Union([Type.String(), Type.Null()]),
  body: Type.String(),
  data: Type.Record(Type.String(), Type.String()),
  status: DeliveryStatus,
  /** Motivo quando `FAILED` (ex.: `UNREGISTERED_DEVICE`). */
  error: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String({ format: 'date-time' }),
});

const Accepted = Type.Object({
  message_id: Type.String({ format: 'uuid' }),
  status: DeliveryStatus,
  error: Type.Union([Type.String(), Type.Null()]),
});

export const messageSinkHttp = defineHttpContract({
  service: 'message-sink',
  title: 'Gateway de SMS e push simulado',
  version: '1.0.0',
  routes: {
    sendSms: {
      method: 'post',
      path: '/v1/sms',
      summary: 'Registra um SMS (nunca enviado a um telefone real).',
      auth: 'public',
      body: SendSms,
      responses: {
        202: { description: 'Registrado, com o status de entrega (RN-MSG-003).', body: Accepted },
      },
    },
    sendPush: {
      method: 'post',
      path: '/v1/push',
      summary: 'Registra uma notificação push (nunca enviada a um aparelho real).',
      auth: 'public',
      body: SendPush,
      responses: {
        202: { description: 'Registrada, com o status de entrega (RN-MSG-003).', body: Accepted },
      },
    },
    getMessage: {
      method: 'get',
      path: '/v1/messages/:message_id',
      summary: 'Consulta uma mensagem e o status de entrega.',
      auth: 'public',
      params: Type.Object({ message_id: Type.String({ format: 'uuid' }) }),
      responses: {
        200: { description: 'A mensagem.', body: Message },
        404: { description: 'Inexistente.' },
      },
    },
    listMessages: {
      method: 'get',
      path: '/v1/messages',
      summary: 'Lista as mensagens, opcionalmente por canal e destinatário.',
      auth: 'public',
      query: Type.Object({
        channel: Type.Optional(Type.Union([Type.Literal('SMS'), Type.Literal('PUSH')])),
        to: Type.Optional(Type.String()),
      }),
      responses: {
        200: { description: 'Mensagens.', body: Type.Object({ messages: Type.Array(Message) }) },
      },
    },
  },
});

export default messageSinkHttp;
