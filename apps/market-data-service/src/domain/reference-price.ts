import { Decimal, Instant, roundDecimal } from '@broker/domain-kernel';
import { Prng, type PrngState } from './prng.js';

/** Origem de cada valor publicado (RN-SYN-002). `SANDBOX_MODEL` (GBM) chega na Fase 7. */
export type ReferenceOrigin = 'BRAPI' | 'GLIDE' | 'SYNTHETIC_NOISE' | 'SANDBOX_MODEL' | 'MANUAL';

/** Parâmetros do preço sintético (Brapi §8.2), todos em configuração. */
export interface SyntheticParams {
  /** `synthetic.noise_enabled`, global e por instrumento (RN-SYN-004). */
  noiseEnabled: boolean;
  /** `synthetic.tick_interval`: sorteado entre min e max (padrão 2–10 s). */
  tickMinMs: number;
  tickMaxMs: number;
  /** Desvio por tick (fração); mínimo 1 bp. Ver `sigmaPerTick`. */
  sigma: number;
  /** Reversão à média por tick (padrão 0,05). */
  kappa: number;
  /** `synthetic.max_noise_pct` (padrão 0,30% = 0,003). */
  maxNoise: number;
  /** `synthetic.glide_duration` (padrão 5 min) em passos lineares de 15 s. */
  glideMs: number;
  glideStepMs: number;
}

export const DEFAULT_SYNTHETIC: SyntheticParams = {
  noiseEnabled: true,
  tickMinMs: 2000,
  tickMaxMs: 10_000,
  sigma: 0.0001,
  kappa: 0.05,
  maxNoise: 0.003,
  glideMs: 300_000,
  glideStepMs: 15_000,
};

/** Deslize linear da âncora antiga para a nova (Brapi §8.1). Instantes em ms Unix. */
interface Glide {
  from: string;
  to: string;
  startAt: number;
}

/**
 * Estado do preço de referência de um instrumento num dia (`reference_price_state`). Serializável:
 * o gerador semeado e o ruído atual vão para o banco, então um reinício continua a mesma sequência.
 */
export interface ReferenceState {
  instrumentId: string;
  tradingDate: string;
  rng: PrngState;
  /** Âncora-alvo: o último preço real aceito. */
  anchor: string;
  externalQuoteTime: string | null;
  glide: Glide | null;
  /** Ruído atual `x` (fração da âncora). */
  noise: number;
  /** Desvio por tick do dia (da volatilidade histórica, `sigmaPerTick`). */
  sigma: number;
  /** Próximo tick de ruído (ms Unix) ou `null` sem ruído. */
  nextTickAt: number | null;
  /** Até onde o modelo já avançou (ms Unix). */
  cursor: number;
  /** Sequência por instrumento, contínua entre os dias. */
  seq: number;
  /** Já publicou algum valor no dia (a primeira âncora sempre publica). */
  publishedToday: boolean;
  lastPrice: string | null;
  lastOrigin: ReferenceOrigin | null;
}

/** Janela do contínuo no dia: o ruído só existe dentro dela (RN-SYN-001). */
export interface ContinuousWindow {
  from: Instant;
  to: Instant;
}

export interface AdvanceOptions {
  /**
   * Valores anteriores a este instante só evoluem o estado, sem publicar (ex.: o serviço subiu no
   * meio do pregão). O estado e os valores seguintes são os mesmos de quem publicou tudo.
   */
  emitFrom?: Instant;
}

/** Override manual (RN-SYN-006): fixa o valor em `[from, until)`. */
export interface ManualOverride {
  price: string;
  from: Instant;
  until: Instant;
}

export interface ReferenceUpdate {
  instrumentId: string;
  seq: number;
  at: Instant;
  /** 4 casas (RN-SYN-003: o tick é aplicado só pelo FMS). */
  price: string;
  origin: ReferenceOrigin;
  anchorPrice: string;
  externalQuoteTime: string | null;
}

/** Semente de RN-SYN-002: `(environment, instrument_id, trading_date)`. */
export const referenceSeed = (environment: string, instrumentId: string, tradingDate: string) =>
  `${environment}|${instrumentId}|${tradingDate}`;

const price4 = (d: Decimal) => roundDecimal(d, 4, 'HALF_UP').toFixed(4);

/**
 * Desvio por tick a partir da volatilidade diária (desvio-padrão dos retornos log dos
 * fechamentos), escalada para o intervalo médio do tick dentro do pregão; mínimo 1 bp (Brapi §8.2).
 */
export function sigmaPerTick(
  closes: readonly string[],
  meanTickMs = 6000,
  sessionMs = 7 * 3_600_000,
): number {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = Number(closes[i - 1]);
    const b = Number(closes[i]);
    if (a > 0 && b > 0) returns.push(Math.log(b / a));
  }
  if (returns.length < 2) return 0.0001;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.max(0.0001, Math.sqrt(variance) * Math.sqrt(meanTickMs / sessionMs));
}

/**
 * Preço de referência (Brapi §8, RN-SYN-001..004/006): `âncora(t) × (1 + ruído(t))`.
 *
 * - Âncora: o último preço real; um preço novo dentro do contínuo desliza linearmente do valor
 *   atual ao novo em passos de 15 s (`GLIDE`). Fora do contínuo a âncora troca na hora (`BRAPI`).
 * - Ruído: Ornstein-Uhlenbeck discreto `x ← x − κx + σz`, limitado a ±`maxNoise`, em ticks de 2–10 s,
 *   só dentro da janela do contínuo (`SYNTHETIC_NOISE`). Fora dela, a referência é a âncora pura.
 * - Override manual: dentro do período, todo valor publicado é o fixado (`MANUAL`).
 *
 * Determinismo: os instantes dos ticks e os choques vêm só do gerador semeado; os passos do glide
 * vêm só do instante das âncoras. Reprocessar o dia com a mesma semente e as mesmas âncoras dá a
 * mesma sequência, qualquer que seja o ritmo em que `advance` é chamado.
 */
export class ReferencePriceModel {
  private constructor(
    private s: ReferenceState,
    private readonly params: SyntheticParams,
    private readonly window: ContinuousWindow | null,
  ) {}

  /** Novo dia: semente própria, ruído zerado, a âncora herdada (último fechamento). */
  static open(input: {
    seed: string;
    instrumentId: string;
    tradingDate: string;
    anchor: string;
    externalQuoteTime: string | null;
    at: Instant;
    previousSeq: number;
    params: SyntheticParams;
    window: ContinuousWindow | null;
    /** Padrão: `params.sigma`. */
    sigma?: number;
  }): ReferencePriceModel {
    const rng = Prng.fromSeed(input.seed);
    const firstTick =
      input.window && input.params.noiseEnabled
        ? input.window.from.epochMillis + rng.int(input.params.tickMinMs, input.params.tickMaxMs)
        : null;
    return new ReferencePriceModel(
      {
        instrumentId: input.instrumentId,
        tradingDate: input.tradingDate,
        rng: rng.state(),
        anchor: input.anchor,
        externalQuoteTime: input.externalQuoteTime,
        glide: null,
        noise: 0,
        sigma: input.sigma ?? input.params.sigma,
        nextTickAt: firstTick,
        cursor: input.at.epochMillis,
        seq: input.previousSeq,
        publishedToday: false,
        lastPrice: null,
        lastOrigin: null,
      },
      input.params,
      input.window,
    );
  }

  static restore(
    state: ReferenceState,
    params: SyntheticParams,
    window: ContinuousWindow | null,
  ): ReferencePriceModel {
    const s = { ...state };
    // Ruído desligado depois da gravação (RN-SYN-004): para de sortear e zera o desvio.
    if (!params.noiseEnabled) {
      s.nextTickAt = null;
      s.noise = 0;
    }
    return new ReferencePriceModel(s, params, window);
  }

  state(): ReferenceState {
    return { ...this.s };
  }

  /** Âncora no instante (com o glide em curso). */
  anchorAt(atMs: number): Decimal {
    const g = this.s.glide;
    if (!g) return new Decimal(this.s.anchor);
    const steps = Math.floor((atMs - g.startAt) / this.params.glideStepMs);
    const progress = Math.min(1, (steps * this.params.glideStepMs) / this.params.glideMs);
    const from = new Decimal(g.from);
    return from.plus(new Decimal(g.to).minus(from).times(progress));
  }

  /**
   * Preço real novo (leitura aceita). Avança até `at` antes de trocar a âncora. Dentro do contínuo
   * começa o glide; fora dele (ou no primeiro preço) troca na hora e publica `BRAPI`.
   */
  onAnchor(
    price: string,
    quoteTime: string,
    at: Instant,
    overrides: readonly ManualOverride[] = [],
    opts: AdvanceOptions = {},
  ): ReferenceUpdate[] {
    const out = this.advance(at, overrides, opts);
    const t = at.epochMillis;
    const current = this.anchorAt(t);
    this.s.externalQuoteTime = quoteTime;
    if (this.inContinuous(t)) {
      if (!current.eq(price)) {
        this.s.glide = { from: current.toString(), to: price, startAt: t };
        this.s.anchor = price;
        return out;
      }
      // Mesmo preço no contínuo: nada muda, salvo se o dia ainda não publicou nenhum valor.
      this.s.glide = null;
      this.s.anchor = price;
      if (this.s.publishedToday) return out;
      out.push(this.emit(t, this.s.noise !== 0 ? 'SYNTHETIC_NOISE' : 'BRAPI', overrides, true)!);
      return out;
    }
    this.s.glide = null;
    this.s.anchor = price;
    this.s.noise = 0;
    out.push(this.emit(t, 'BRAPI', overrides, true)!);
    return out;
  }

  /** Avança o modelo até `until`, gerando os passos de glide e os ticks de ruído vencidos. */
  advance(
    until: Instant,
    overrides: readonly ManualOverride[] = [],
    opts: AdvanceOptions = {},
  ): ReferenceUpdate[] {
    const out: ReferenceUpdate[] = [];
    const end = until.epochMillis;
    const emitFrom = opts.emitFrom?.epochMillis ?? Number.NEGATIVE_INFINITY;
    for (;;) {
      const next = this.nextEventAt(overrides);
      if (next === null || next > end) break;
      this.s.cursor = next;
      let origin: ReferenceOrigin;
      if (next === this.s.nextTickAt) {
        this.noiseTick(next);
        origin = 'SYNTHETIC_NOISE';
      } else {
        if (this.window && next >= this.window.to.epochMillis) this.s.noise = 0;
        origin = this.s.glide ? 'GLIDE' : 'BRAPI';
      }
      const u = this.emit(next, origin, overrides, next >= emitFrom);
      if (u) out.push(u);
      if (this.s.glide && next >= this.s.glide.startAt + this.params.glideMs) this.s.glide = null;
    }
    if (end > this.s.cursor) this.s.cursor = end;
    return out;
  }

  /**
   * Próximo instante com publicação: tick de ruído, passo do glide, fim do contínuo com ruído
   * pendente (um último valor sem ruído) ou fronteira de um override (o valor fixado entra e sai
   * na hora certa).
   */
  private nextEventAt(overrides: readonly ManualOverride[]): number | null {
    const candidates: number[] = [];
    if (this.s.nextTickAt !== null) candidates.push(this.s.nextTickAt);
    const g = this.s.glide;
    if (g) {
      const stepIndex = Math.floor((this.s.cursor - g.startAt) / this.params.glideStepMs) + 1;
      const step = g.startAt + stepIndex * this.params.glideStepMs;
      if (step <= g.startAt + this.params.glideMs) candidates.push(step);
    }
    if (this.window && this.s.noise !== 0) candidates.push(this.window.to.epochMillis);
    for (const o of overrides) candidates.push(o.from.epochMillis, o.until.epochMillis);
    const after = candidates.filter((c) => c > this.s.cursor);
    return after.length ? Math.min(...after) : null;
  }

  private noiseTick(atMs: number): void {
    const rng = new Prng(this.s.rng);
    const z = rng.gaussian();
    const p = this.params;
    let x = this.s.noise - p.kappa * this.s.noise + this.s.sigma * z;
    x = Math.max(-p.maxNoise, Math.min(p.maxNoise, x));
    this.s.noise = x;
    const next = atMs + rng.int(p.tickMinMs, p.tickMaxMs);
    this.s.nextTickAt = this.window && next < this.window.to.epochMillis ? next : null;
    this.s.rng = rng.state();
  }

  private inContinuous(atMs: number): boolean {
    return (
      this.window !== null &&
      atMs >= this.window.from.epochMillis &&
      atMs < this.window.to.epochMillis
    );
  }

  /** Calcula o valor no instante; com `publish = false` só atualiza o estado (sem `seq`). */
  private emit(
    atMs: number,
    origin: ReferenceOrigin,
    overrides: readonly ManualOverride[],
    publish: boolean,
  ): ReferenceUpdate | null {
    const at = Instant.ofEpochMillis(atMs);
    const anchor = this.anchorAt(atMs);
    const manual = overrides.find((o) => !at.isBefore(o.from) && at.isBefore(o.until));
    const value = manual
      ? new Decimal(manual.price)
      : anchor.times(new Decimal(1).plus(new Decimal(this.s.noise.toFixed(12))));
    const finalOrigin: ReferenceOrigin = manual ? 'MANUAL' : origin;
    this.s.lastPrice = price4(value);
    this.s.lastOrigin = finalOrigin;
    if (!publish) return null;
    this.s.seq++;
    this.s.publishedToday = true;
    return {
      instrumentId: this.s.instrumentId,
      seq: this.s.seq,
      at,
      price: this.s.lastPrice,
      origin: finalOrigin,
      anchorPrice: price4(anchor),
      externalQuoteTime: this.s.externalQuoteTime,
    };
  }
}
