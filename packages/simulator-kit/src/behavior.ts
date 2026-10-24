import type { Clock } from '@broker/clock';
import { Instant } from '@broker/domain-kernel';
import { HttpError } from '@broker/service-kit';
import type { RequestHandler } from 'express';
import Type, { type Static } from 'typebox';

export type Latency =
  { kind: 'fixed'; ms: number } | { kind: 'uniform'; minMs: number; maxMs: number };

/** Como o erro transitório se manifesta: `503` imediato, ou a conexão fica pendurada e cai (timeout). */
export type TransientMode = 'status' | 'timeout' | 'mixed';

export interface UnavailabilityWindow {
  from: Instant;
  to: Instant;
}

/** Comportamento configurável de um simulador (RN-SIM-002). */
export interface Behavior {
  latency: Latency;
  /** Probabilidade (0–1) de erro transitório (`503`/timeout): o cliente deve tentar de novo. */
  transientErrorRate: number;
  transientMode: TransientMode;
  /** Quanto a conexão fica pendurada no modo timeout antes de cair. */
  hangMs: number;
  /** Probabilidade (0–1) de erro definitivo (`422`): tentar de novo não adianta. */
  definitiveErrorRate: number;
  unavailability: UnavailabilityWindow[];
}

/** Variáveis de ambiente do comportamento; entram no `Config` de cada simulador. */
export const SimulatorConfigProperties = {
  /** `200` (fixa) ou `100-500` (uniforme entre os dois), em ms. */
  SIM_LATENCY_MS: Type.String({ pattern: '^\\d+(-\\d+)?$', default: '0' }),
  SIM_TRANSIENT_ERROR_RATE: Type.Number({ minimum: 0, maximum: 1, default: 0 }),
  SIM_TRANSIENT_MODE: Type.Union(
    [Type.Literal('status'), Type.Literal('timeout'), Type.Literal('mixed')],
    {
      default: 'status',
    },
  ),
  SIM_HANG_MS: Type.Integer({ minimum: 0, default: 30_000 }),
  SIM_DEFINITIVE_ERROR_RATE: Type.Number({ minimum: 0, maximum: 1, default: 0 }),
  /** Janelas programadas: `<início ISO>/<fim ISO>` separadas por vírgula. */
  SIM_UNAVAILABLE: Type.String({ default: '' }),
};
export const SimulatorConfigSchema = Type.Object(SimulatorConfigProperties);
export type SimulatorConfig = Static<typeof SimulatorConfigSchema>;

export function parseLatency(spec: string): Latency {
  const [a, b] = spec.split('-').map(Number);
  if (b === undefined) return { kind: 'fixed', ms: a! };
  if (b < a!) throw new Error(`latência inválida: ${spec}`);
  return { kind: 'uniform', minMs: a!, maxMs: b };
}

export function formatLatency(latency: Latency): string {
  return latency.kind === 'fixed' ? String(latency.ms) : `${latency.minMs}-${latency.maxMs}`;
}

export function behaviorFromConfig(config: SimulatorConfig): Behavior {
  return {
    latency: parseLatency(config.SIM_LATENCY_MS),
    transientErrorRate: config.SIM_TRANSIENT_ERROR_RATE,
    transientMode: config.SIM_TRANSIENT_MODE,
    hangMs: config.SIM_HANG_MS,
    definitiveErrorRate: config.SIM_DEFINITIVE_ERROR_RATE,
    unavailability: config.SIM_UNAVAILABLE.split(',')
      .map((w) => w.trim())
      .filter(Boolean)
      .map((w) => {
        const [from, to] = w.split('/');
        return { from: Instant.parse(from!), to: Instant.parse(to!) };
      }),
  };
}

export const NO_FAULTS: Behavior = {
  latency: { kind: 'fixed', ms: 0 },
  transientErrorRate: 0,
  transientMode: 'status',
  hangMs: 30_000,
  definitiveErrorRate: 0,
  unavailability: [],
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Estado de controle de um simulador: o comportamento (vem do ambiente e muda pela UI/API admin)
 * e os cenários forçados de uso único (ex.: "o próximo PIX enviado falha", RN-PIXS-003).
 * Fica em memória: reiniciar o simulador volta ao que o ambiente define.
 */
export class SimulatorControl<S extends string = string> {
  private readonly armed = new Map<S, number>();

  constructor(
    public behavior: Behavior,
    private readonly clock: Clock,
    /** Fonte de aleatoriedade em [0, 1); injete um PRNG semeado nos testes. */
    private readonly random: () => number = Math.random,
  ) {}

  /** Indisponível agora? (janela programada ou forçada pela UI) */
  unavailableUntil(): Instant | undefined {
    const now = this.clock.now();
    return this.behavior.unavailability.find((w) => !now.isBefore(w.from) && now.isBefore(w.to))
      ?.to;
  }

  /** Abre uma janela de indisponibilidade a partir de agora (cenário "fora do ar por 10 min"). */
  makeUnavailable(minutes: number): UnavailabilityWindow {
    const from = this.clock.now();
    const window = { from, to: from.plusMillis(minutes * 60_000) };
    this.behavior = { ...this.behavior, unavailability: [...this.behavior.unavailability, window] };
    return window;
  }

  clearUnavailability(): void {
    this.behavior = { ...this.behavior, unavailability: [] };
  }

  /** Arma um cenário para as próximas `times` operações que o consultarem. */
  arm(scenario: S, times = 1): void {
    this.armed.set(scenario, (this.armed.get(scenario) ?? 0) + times);
  }

  disarm(scenario: S): void {
    this.armed.delete(scenario);
  }

  /** Consome uma armação do cenário, se houver. */
  consume(scenario: S): boolean {
    const n = this.armed.get(scenario) ?? 0;
    if (n === 0) return false;
    if (n === 1) this.armed.delete(scenario);
    else this.armed.set(scenario, n - 1);
    return true;
  }

  armedScenarios(): Array<{ scenario: S; remaining: number }> {
    return [...this.armed].map(([scenario, remaining]) => ({ scenario, remaining }));
  }

  /**
   * Middleware para a API do simulador (registre-o com `service.use` antes das rotas da API, depois
   * das rotas de UI/admin, que nunca falham). Ordem: indisponibilidade → latência → erro transitório
   * → erro definitivo.
   */
  middleware(): RequestHandler {
    return async (_req, res, next) => {
      const until = this.unavailableUntil();
      if (until) {
        const retryAfter = Math.max(
          1,
          Math.ceil((until.epochMillis - this.clock.now().epochMillis) / 1000),
        );
        throw new HttpError(
          503,
          'SIMULATED_UNAVAILABLE',
          `Simulador fora do ar até ${until.toString()}.`,
          {
            headers: { 'Retry-After': String(retryAfter) },
          },
        );
      }
      const { latency } = this.behavior;
      const delay =
        latency.kind === 'fixed'
          ? latency.ms
          : latency.minMs + Math.floor(this.random() * (latency.maxMs - latency.minMs + 1));
      if (delay > 0) await sleep(delay);
      if (this.random() < this.behavior.transientErrorRate) {
        const mode =
          this.behavior.transientMode === 'mixed'
            ? this.random() < 0.5
              ? 'status'
              : 'timeout'
            : this.behavior.transientMode;
        if (mode === 'timeout') {
          await sleep(this.behavior.hangMs);
          res.socket?.destroy();
          return;
        }
        throw new HttpError(503, 'SIMULATED_TRANSIENT_ERROR', 'Erro transitório simulado.', {
          headers: { 'Retry-After': '1' },
        });
      }
      if (this.random() < this.behavior.definitiveErrorRate) {
        throw new HttpError(422, 'SIMULATED_DEFINITIVE_ERROR', 'Erro definitivo simulado.');
      }
      next();
    };
  }
}
