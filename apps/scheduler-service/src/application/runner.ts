import type { TradingCalendar } from '@broker/calendar';
import type { Instant } from '@broker/domain-kernel';
import { nextDueAfter } from '../domain/routines.js';
import { ClockModeError, type EnvironmentClock } from './environment-clock.js';
import type { SchedulerStore } from './ports.js';
import type { Scheduler } from './scheduler.js';

export class NotLeaderError extends Error {}

/**
 * Laço do agendador líder: publica o relógio (modos virtuais) e dá os passos de disparo. Tudo passa
 * por uma fila de um só lugar (`serially`): um tick, um `advance_to` e uma conclusão de rotina
 * nunca rodam ao mesmo tempo no mesmo processo.
 */
export class SchedulerRunner {
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly o: {
      scheduler: Scheduler;
      clock: EnvironmentClock;
      store: SchedulerStore;
      calendar: TradingCalendar;
      isLeader: () => boolean;
      /** Atualiza a cópia local do calendário antes de decidir (D15). */
      refreshCalendar?: () => Promise<void>;
      onError?: (err: unknown) => void;
    },
  ) {}

  /** Um ciclo: tick do relógio (se houver) e um passo de disparo. Fora da liderança, nada. */
  tick(): Promise<void> {
    return this.serially(async () => {
      if (!this.o.isLeader()) return;
      await this.o.refreshCalendar?.();
      await this.publishTick();
      await this.o.scheduler.step();
    });
  }

  /**
   * `advance_to(t)` no modo VIRTUAL: anda até `t` parando em cada horário de rotina do caminho, com
   * um `clock.ticked` e um passo em cada parada. Assim um salto de dias dispara as rotinas na
   * mesma ordem e com o mesmo tempo que teriam se o relógio andasse de verdade.
   */
  advanceTo(target: Instant): Promise<Instant> {
    return this.serially(async () => {
      if (this.o.clock.mode !== 'VIRTUAL') {
        throw new ClockModeError(
          `advance_to só existe no modo VIRTUAL (atual: ${this.o.clock.mode})`,
        );
      }
      if (!this.o.isLeader()) throw new NotLeaderError('esta instância não é a líder do agendador');
      if (target.isBefore(this.o.clock.now())) {
        throw new ClockModeError(
          `o relógio não volta: ${this.o.clock.now().toString()} → ${target.toString()}`,
        );
      }
      await this.o.refreshCalendar?.();
      await this.o.scheduler.step();
      const definitions = await this.o.store.definitions();
      for (;;) {
        const next =
          nextDueAfter({
            definitions,
            calendar: this.o.calendar,
            after: this.o.clock.now(),
            until: target,
          }) ?? target;
        this.o.clock.advanceTo(next);
        await this.publishTick();
        await this.o.scheduler.step();
        if (!next.isBefore(target)) return target;
      }
    });
  }

  /** Conclusão de rotina: grava e já tenta liberar as dependentes (RN-ROT-002). */
  afterFinish(finish: () => Promise<unknown>): Promise<void> {
    return this.serially(async () => {
      await finish();
      if (this.o.isLeader()) await this.o.scheduler.step();
    });
  }

  /** Ao virar líder: retoma o relógio gravado pelo líder anterior antes do primeiro passo. */
  elected(): Promise<void> {
    return this.serially(() => this.o.clock.reload(this.o.store));
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.tick().catch((err: unknown) => this.o.onError?.(err)),
      intervalMs,
    );
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.chain.catch(() => undefined);
  }

  private async publishTick(): Promise<void> {
    const at = this.o.clock.pendingTick();
    if (!at) return;
    const { mode, speedFactor } = this.o.clock;
    if (mode === 'REAL') return;
    await this.o.store.transaction(async (tx) => {
      await tx.publish({
        type: 'clock.ticked',
        payload: { virtualNow: at.toString(), mode, speedFactor },
      });
      await tx.saveClock(this.o.clock.stateAt(at));
    });
    this.o.clock.markTicked(at);
  }

  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
