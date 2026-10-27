/**
 * Disjuntor do cliente da brapi (RN-BRP-080): abre após `failureThreshold` falhas consecutivas
 * (`5xx`/timeout), fica aberto por `openMs` e deixa passar uma única requisição de teste
 * (meia-abertura). Sucesso fecha; falha na meia-abertura reabre. Enquanto aberto, nada é enviado
 * e as cotações envelhecem (a última válida continua valendo, RN-BRP-081).
 *
 * Puro: o tempo chega como argumento (ms do relógio de parede do processo, que mede a brapi real).
 */
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface BreakerOptions {
  /** Padrão 5. */
  failureThreshold: number;
  /** Padrão 2 min. */
  openMs: number;
}

export const DEFAULT_BREAKER: BreakerOptions = { failureThreshold: 5, openMs: 120_000 };

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probing = false;

  constructor(private readonly options: BreakerOptions = DEFAULT_BREAKER) {}

  state(nowMs: number): BreakerState {
    if (this.openedAt === null) return 'CLOSED';
    return nowMs - this.openedAt >= this.options.openMs ? 'HALF_OPEN' : 'OPEN';
  }

  /** Pode enviar agora? Na meia-abertura, só a primeira chamada recebe `true` (a de teste). */
  tryAcquire(nowMs: number): boolean {
    const s = this.state(nowMs);
    if (s === 'CLOSED') return true;
    if (s === 'OPEN' || this.probing) return false;
    this.probing = true;
    return true;
  }

  /** Quando o disjuntor volta a aceitar a requisição de teste (`null` se fechado). */
  reopensAt(): number | null {
    return this.openedAt === null ? null : this.openedAt + this.options.openMs;
  }

  onSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.probing = false;
  }

  /** Só `5xx` e timeout contam; `4xx` não dizem nada sobre a saúde da brapi. */
  onFailure(nowMs: number): void {
    this.failures++;
    if (this.probing || this.failures >= this.options.failureThreshold) {
      this.openedAt = nowMs;
      this.probing = false;
    }
  }

  /** Libera a meia-abertura sem veredito (ex.: a requisição de teste deu `4xx`). */
  onNeutral(): void {
    if (this.probing) this.onSuccess();
  }

  consecutiveFailures(): number {
    return this.failures;
  }
}
