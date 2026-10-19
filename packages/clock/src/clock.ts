import { BusinessDate, Instant } from '@broker/domain-kernel';

/** Modos do relógio do ambiente (RN-CLK-002). Um ambiente nunca mistura modos (RN-CLK-003). */
export type ClockMode = 'REAL' | 'ACCELERATED' | 'VIRTUAL';

/**
 * Porta de relógio (RN-CLK-001, ADR-0009). Toda regra temporal pergunta a hora aqui; o domínio
 * nunca lê o relógio da máquina (o ESLint bloqueia `Date.now`/`new Date()` em `domain/`).
 */
export interface Clock {
  readonly mode: ClockMode;
  /** Instante atual no tempo do ambiente (é o `occurred_at` dos eventos, RN-CLK-004). */
  now(): Instant;
  /** Data de negócio atual em `America/Sao_Paulo` (P-02). */
  businessDate(): BusinessDate;
}

/** Fonte do tempo real da máquina, em ms Unix. Injetável para testes. */
export type WallClock = () => number;

const systemWallClock: WallClock = () => Date.now();

abstract class BaseClock implements Clock {
  abstract readonly mode: ClockMode;
  abstract now(): Instant;

  businessDate(): BusinessDate {
    return this.now().businessDate();
  }
}

/** `REAL`: tempo real (UTC) da máquina, sincronizado por NTP. */
export class RealClock extends BaseClock {
  readonly mode = 'REAL' as const;

  constructor(private readonly wall: WallClock = systemWallClock) {
    super();
  }

  now(): Instant {
    return Instant.ofEpochMillis(this.wall());
  }
}

export interface AcceleratedClockOptions {
  /** Instante virtual em que o relógio começa. */
  start: Instant;
  /** Quantas vezes o tempo virtual corre mais rápido que o real (ex.: 6,5 h de pregão em 1 h ≈ 6.5). */
  speedFactor: number;
  wall?: WallClock;
}

/**
 * `ACCELERATED` (sandbox): o tempo virtual avança `speedFactor` vezes mais rápido que o real.
 * virtual = start + (real − realNoInício) × speedFactor
 */
export class AcceleratedClock extends BaseClock {
  readonly mode = 'ACCELERATED' as const;
  private readonly wall: WallClock;
  private readonly wallStart: number;

  constructor(private readonly options: AcceleratedClockOptions) {
    super();
    if (!(options.speedFactor > 0))
      throw new Error(`speedFactor precisa ser > 0: ${options.speedFactor}`);
    this.wall = options.wall ?? systemWallClock;
    this.wallStart = this.wall();
  }

  get speedFactor(): number {
    return this.options.speedFactor;
  }

  now(): Instant {
    const elapsed = (this.wall() - this.wallStart) * this.options.speedFactor;
    return this.options.start.plusMillis(Math.floor(elapsed));
  }
}

/**
 * `VIRTUAL` (replay e testes): parado; só avança por comando explícito (`advanceTo`).
 * O tempo nunca volta: avançar para um instante anterior é erro.
 */
export class VirtualClock extends BaseClock {
  readonly mode = 'VIRTUAL' as const;
  private current: Instant;

  constructor(start: Instant) {
    super();
    this.current = start;
  }

  now(): Instant {
    return this.current;
  }

  /** `advance_to(t)` de RN-CLK-002. Aceita o mesmo instante (idempotente). */
  advanceTo(target: Instant): void {
    if (target.isBefore(this.current)) {
      throw new Error(
        `o relógio virtual não volta: ${this.current.toString()} → ${target.toString()}`,
      );
    }
    this.current = target;
  }

  advanceBy(ms: number): void {
    if (ms < 0) throw new Error('o relógio virtual não volta');
    this.advanceTo(this.current.plusMillis(ms));
  }
}

export type ClockConfig =
  | { mode: 'REAL' }
  | { mode: 'ACCELERATED'; start: string; speedFactor: number }
  | { mode: 'VIRTUAL'; start: string };

/** Cria o relógio a partir da configuração validada do ambiente. */
export function createClock(config: ClockConfig, wall: WallClock = systemWallClock): Clock {
  switch (config.mode) {
    case 'REAL':
      return new RealClock(wall);
    case 'ACCELERATED':
      return new AcceleratedClock({
        start: Instant.parse(config.start),
        speedFactor: config.speedFactor,
        wall,
      });
    case 'VIRTUAL':
      return new VirtualClock(Instant.parse(config.start));
  }
}

/**
 * Carimbos de um evento ou log (RN-CLK-004): `occurred_at` no tempo do ambiente e
 * `wall_clock_at` no tempo real da máquina, para os logs técnicos.
 */
export function timestamps(
  clock: Clock,
  wall: WallClock = systemWallClock,
): { occurredAt: Instant; wallClockAt: Instant } {
  return { occurredAt: clock.now(), wallClockAt: Instant.ofEpochMillis(wall()) };
}
