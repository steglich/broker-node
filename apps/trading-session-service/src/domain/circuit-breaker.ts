import { Decimal, type Instant } from '@broker/domain-kernel';

export type CircuitBreakerLevel = 1 | 2 | 3;

/** Pregão §6: queda mínima do índice e interrupção (`null` = prazo do backoffice). */
export const CIRCUIT_BREAKER_LEVELS: Readonly<
  Record<CircuitBreakerLevel, { drop: Decimal; haltSeconds: number | null }>
> = {
  1: { drop: new Decimal('0.10'), haltSeconds: 30 * 60 },
  2: { drop: new Decimal('0.15'), haltSeconds: 60 * 60 },
  3: { drop: new Decimal('0.20'), haltSeconds: null },
};

/** RN-CB-004: a retomada é por leilão de pré-abertura de 15 minutos. */
export const CIRCUIT_BREAKER_RESUME_AUCTION_S = 15 * 60;

export const circuitBreakerReason = (level: CircuitBreakerLevel) => `CIRCUIT_BREAKER_L${level}`;

/** O próximo nível na sequência (RN-CB-001: cada um uma vez); `null` depois do nível 3. */
export function nextCircuitBreakerLevel(triggered: readonly number[]): CircuitBreakerLevel | null {
  for (const level of [1, 2, 3] as const) if (!triggered.includes(level)) return level;
  return null;
}

/** Variação do índice sobre o fechamento anterior, em fração (-0,10 = queda de 10%). */
export function indexChange(last: Decimal, previousClose: Decimal): Decimal {
  return last.minus(previousClose).dividedBy(previousClose);
}

/**
 * Disparo automático (Pregão §6). Os níveis são sequenciais, e o seguinte só vale depois da retomada
 * do anterior: quem chama garante que o mercado está em negociação contínua. Na última meia hora do
 * contínuo não dispara (RN-CB-002, com `blackoutMinutes` parametrizável).
 */
export function evaluateCircuitBreaker(input: {
  change: Decimal;
  triggered: readonly number[];
  now: Instant;
  continuousEndsAt: Instant;
  blackoutMinutes: number;
}): CircuitBreakerLevel | null {
  const blackoutStart = input.continuousEndsAt.plusMillis(-input.blackoutMinutes * 60_000);
  if (!input.now.isBefore(blackoutStart)) return null;
  const level = nextCircuitBreakerLevel(input.triggered);
  if (level === null) return null;
  return input.change.negated().greaterThanOrEqualTo(CIRCUIT_BREAKER_LEVELS[level].drop)
    ? level
    : null;
}
