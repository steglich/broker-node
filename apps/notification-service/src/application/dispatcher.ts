// Entrega por canal (RN-NOT-G-007): e-mail pelo Mailpit (SMTP) e SMS/push pelo message-sink, com
// backoff exponencial até o prazo do canal e falha definitiva registrada (`notification.failed`).
import { nextAttempt, RETRY } from '../domain/delivery.js';
import { RETENTION_MS, type NotificationDeps } from './context.js';
import { publishCreated } from './notifier.js';
import { DeliveryError, type DueDelivery, type Recipient } from './ports.js';

/** Reserva de uma entrega em andamento: se a instância cair, outra retoma depois disso. */
const LEASE_MS = 2 * 60_000;
/** Sem aparelho registrado não é falha: o cliente só não usa o app. */
const NO_DEVICE = 'NO_PUSH_DEVICE';

type Outcome = { ok: true } | { ok: false; error: DeliveryError };

export class Dispatcher {
  constructor(private readonly d: NotificationDeps) {}

  /** Uma rodada: envia as entregas vencidas. Devolve quantas tentou. */
  async runDue(limit = 50): Promise<number> {
    const due = await this.d.store.transaction((tx) =>
      tx.claimDue(this.d.clock.now(), LEASE_MS, limit),
    );
    // O contato é lido na hora (nunca guardado aqui) e uma vez por usuário na rodada.
    const contacts = new Map<string, Promise<Recipient | null>>();
    for (const delivery of due) await this.deliver(delivery, contacts);
    return due.length;
  }

  /** Agrupadas cuja janela fechou: entram na central e publicam `notification.created`. */
  async releaseGroups(limit = 100): Promise<number> {
    return this.d.store.transaction(async (tx) => {
      const released = await tx.takeReleased(this.d.clock.now(), limit);
      for (const n of released) await publishCreated(tx, n);
      return released.length;
    });
  }

  /** RN-NOT-G-008: a central guarda 90 dias. */
  async purge(limit = 1000): Promise<number> {
    const before = this.d.clock.now().plusMillis(-RETENTION_MS);
    return this.d.store.transaction((tx) => tx.purge(before, limit));
  }

  private async deliver(
    d: DueDelivery,
    contacts: Map<string, Promise<Recipient | null>>,
  ): Promise<void> {
    const attempts = d.attempts + 1;
    let outcome: Outcome;
    try {
      await this.send(d, contacts);
      outcome = { ok: true };
    } catch (err) {
      outcome = {
        ok: false,
        error:
          err instanceof DeliveryError
            ? err
            : new DeliveryError('TRANSIENT', 'UNEXPECTED', (err as Error).message),
      };
    }
    const now = this.d.clock.now();
    await this.d.store.transaction(async (tx) => {
      const base = { userId: d.userId, code: d.code, notificationId: d.notificationId };
      if (outcome.ok) {
        await tx.saveDelivery({
          ...d,
          status: 'DELIVERED',
          attempts,
          nextAttemptAt: null,
          lastError: null,
          deliveredAt: now,
        });
        await tx.publish(
          {
            type: 'notification.delivered',
            payload: { ...base, channel: d.channel, attempts, deliveredAt: now.toString() },
          },
          d.userId,
        );
        return;
      }
      const { error } = outcome;
      if (error.code === NO_DEVICE) {
        await tx.saveDelivery({
          ...d,
          status: 'SKIPPED',
          attempts,
          nextAttemptAt: null,
          lastError: error.code,
        });
        return;
      }
      const next =
        error.kind === 'TRANSIENT'
          ? nextAttempt(RETRY[d.channel], attempts, now, d.deadlineAt ?? now)
          : null;
      if (next) {
        await tx.saveDelivery({ ...d, attempts, nextAttemptAt: next, lastError: error.code });
        return;
      }
      const reason = error.kind === 'TRANSIENT' ? 'DEADLINE_EXCEEDED' : error.code;
      await tx.saveDelivery({
        ...d,
        status: 'FAILED',
        attempts,
        nextAttemptAt: null,
        lastError: `${reason}: ${error.message}`.slice(0, 500),
      });
      await tx.publish(
        { type: 'notification.failed', payload: { ...base, channel: d.channel, attempts, reason } },
        d.userId,
      );
      this.d.logger.warn(
        {
          event: 'notification.delivery_failed',
          notificationId: d.notificationId,
          channel: d.channel,
          reason,
        },
        'entrega com falha definitiva',
      );
    });
  }

  private async contact(userId: string, cache: Map<string, Promise<Recipient | null>>) {
    let p = cache.get(userId);
    if (!p) {
      p = this.d.recipients.resolve({ userId }).catch((err: unknown) => {
        cache.delete(userId);
        throw new DeliveryError('TRANSIENT', 'RECIPIENT_UNAVAILABLE', (err as Error).message);
      });
      cache.set(userId, p);
    }
    return p;
  }

  private async send(d: DueDelivery, cache: Map<string, Promise<Recipient | null>>) {
    const deepLink = d.data['deepLink'] ?? '/notificacoes';
    if (d.channel === 'EMAIL') {
      const to = (await this.contact(d.userId, cache))?.email;
      if (!to) throw new DeliveryError('DEFINITIVE', 'NO_EMAIL', 'destinatário sem e-mail');
      await this.d.email.send({
        to,
        subject: d.title,
        text: `${d.body}\n\nAbra no app: ${this.d.appUrl}${deepLink}\n`,
        messageId: `<${d.notificationId}.email@broker.localhost>`,
      });
      return;
    }
    if (d.channel === 'SMS') {
      const to = (await this.contact(d.userId, cache))?.phone;
      if (!to) throw new DeliveryError('DEFINITIVE', 'NO_PHONE', 'destinatário sem celular');
      const r = await this.d.sink.sms({ to, body: d.body });
      if (r.status === 'FAILED')
        throw new DeliveryError('DEFINITIVE', r.error ?? 'SMS_FAILED', 'SMS recusado');
      return;
    }
    // PUSH: todos os aparelhos ativos; basta um receber.
    const devices = await this.d.store.transaction((tx) => tx.pushDevices(d.userId));
    if (devices.length === 0)
      throw new DeliveryError('DEFINITIVE', NO_DEVICE, 'nenhum aparelho registrado');
    let delivered = false;
    let lastError = 'PUSH_FAILED';
    for (const device of devices) {
      const r = await this.d.sink.push({
        deviceToken: this.d.tokens.open(device.tokenEnc),
        title: d.title,
        body: d.body,
        data: { ...d.data, notificationId: d.notificationId, code: d.code },
      });
      if (r.status === 'DELIVERED') delivered = true;
      else {
        lastError = r.error ?? lastError;
        if (r.error === 'UNREGISTERED_DEVICE')
          await this.d.store.transaction((tx) => tx.markDeviceUnregistered(device.id));
      }
    }
    if (!delivered) throw new DeliveryError('DEFINITIVE', lastError, 'push não entregue');
  }
}
