import type { Clock } from '@broker/clock';
import { BusinessDate, Instant } from '@broker/domain-kernel';
import type { ClockMode, SchedulerStore, StoredClock } from './ports.js';

export class ClockModeError extends Error {}

const MINUTE = 60_000;
const floorMinute = (i: Instant) =>
  Instant.ofEpochMillis(Math.floor(i.epochMillis / MINUTE) * MINUTE);

/**
 * O relógio do ambiente, do qual o agendador é o dono (D15, ADR-0009, RN-CLK-002/003).
 *
 * - `REAL`: tempo da máquina.
 * - `ACCELERATED`: virtual = âncora + (real − realNaÂncora) × speedFactor.
 * - `VIRTUAL`: parado; só anda por `advanceTo`.
 *
 * Nos modos virtuais o tempo fica gravado (`clock_state`) a cada tick: reiniciar o agendador, ou
 * trocar de líder, continua do ponto em que parou em vez de voltar ao início configurado.
 */
export class EnvironmentClock implements Clock {
  private anchorVirtual: Instant;
  private anchorWall: number;
  private lastTick: Instant | null;

  private constructor(
    readonly mode: ClockMode,
    readonly speedFactor: number,
    start: Instant,
    private readonly wall: () => number,
    lastTick: Instant | null,
  ) {
    this.anchorVirtual = start;
    this.anchorWall = wall();
    this.lastTick = lastTick;
  }

  static async load(
    store: SchedulerStore,
    config: { mode: ClockMode; start?: Instant; speedFactor?: number },
    wall: () => number = () => Date.now(),
  ): Promise<EnvironmentClock> {
    if (config.mode === 'REAL')
      return new EnvironmentClock('REAL', 1, Instant.ofEpochMillis(wall()), wall, null);
    const stored = await store.transaction((tx) => tx.loadClock());
    if (stored && stored.mode !== config.mode) {
      // RN-CLK-003: um ambiente nunca mistura modos. Trocar o modo exige recriar o ambiente.
      throw new ClockModeError(
        `o ambiente está em ${stored.mode}; a configuração pede ${config.mode}`,
      );
    }
    const start = stored?.virtualNow ?? config.start;
    if (!start) throw new ClockModeError(`CLOCK_START é obrigatório no modo ${config.mode}`);
    const speed = config.mode === 'VIRTUAL' ? 1 : (stored?.speedFactor ?? config.speedFactor ?? 1);
    if (!(speed > 0)) throw new ClockModeError(`speedFactor precisa ser > 0: ${speed}`);
    return new EnvironmentClock(config.mode, speed, start, wall, stored?.virtualNow ?? null);
  }

  now(): Instant {
    if (this.mode === 'REAL') return Instant.ofEpochMillis(this.wall());
    if (this.mode === 'VIRTUAL') return this.anchorVirtual;
    return this.anchorVirtual.plusMillis(
      Math.floor((this.wall() - this.anchorWall) * this.speedFactor),
    );
  }

  businessDate(): BusinessDate {
    return this.now().businessDate();
  }

  /** `advance_to(t)` (RN-CLK-002): só em `VIRTUAL`, e o tempo nunca volta. */
  advanceTo(target: Instant): void {
    if (this.mode !== 'VIRTUAL')
      throw new ClockModeError(`advance_to só existe no modo VIRTUAL (atual: ${this.mode})`);
    if (target.isBefore(this.anchorVirtual)) {
      throw new ClockModeError(
        `o relógio não volta: ${this.anchorVirtual.toString()} → ${target.toString()}`,
      );
    }
    this.anchorVirtual = target;
  }

  /**
   * O instante a publicar como `clock.ticked`, se houver um novo: em `ACCELERATED`, cada minuto
   * virtual (RN-CLK-003); em `VIRTUAL`, o ponto atual depois de um `advanceTo`.
   */
  pendingTick(): Instant | null {
    if (this.mode === 'REAL') return null;
    const at = this.mode === 'ACCELERATED' ? floorMinute(this.now()) : this.anchorVirtual;
    return this.lastTick && !at.isAfter(this.lastTick) ? null : at;
  }

  /** Estado a gravar junto com o tick (na mesma transação do `clock.ticked`). */
  stateAt(at: Instant): StoredClock {
    return { mode: this.mode, virtualNow: at, speedFactor: this.speedFactor };
  }

  /** Chamado depois do commit do tick: só então ele conta como publicado. */
  markTicked(at: Instant): void {
    this.lastTick = at;
  }

  /**
   * Recarrega o tempo gravado. Uma réplica em espera chama ao virar líder: o relógio dela parou
   * no instante em que subiu, e o líder anterior pode ter andado bastante desde então.
   */
  async reload(store: SchedulerStore): Promise<void> {
    if (this.mode === 'REAL') return;
    const stored = await store.transaction((tx) => tx.loadClock());
    if (!stored) return;
    this.anchorVirtual = stored.virtualNow;
    this.anchorWall = this.wall();
    this.lastTick = stored.virtualNow;
  }
}
