/**
 * Preço interno do Motor: inteiro com 8 casas (D12 fala em centavos; o contrato admite até 8). O
 * caminho quente só compara e soma inteiros, sem `Decimal` nem ponto flutuante (ADR-0004). Cabe em
 * `Number` com folga: o inteiro seguro equivale a R$ 90 milhões por ação.
 */
export type IntPrice = number;

const SCALE_DIGITS = 8;
const SCALE = 100_000_000n;

/** Compra a mercado no leilão: limite mais agressivo possível (RN-AUC-011). */
export const MARKET_BUY: IntPrice = Number.MAX_SAFE_INTEGER;
/** Venda a mercado no leilão (RN-AUC-011). */
export const MARKET_SELL: IntPrice = 0;

const DECIMAL = /^(\d+)(?:\.(\d{1,8}))?$/;

export function parsePrice(text: string): IntPrice {
  const match = DECIMAL.exec(text);
  if (!match) throw new Error(`preço inválido: ${text}`);
  const fraction = (match[2] ?? '').padEnd(SCALE_DIGITS, '0');
  const value = Number(match[1]!) * 100_000_000 + Number(fraction);
  if (!Number.isSafeInteger(value)) throw new Error(`preço fora da faixa: ${text}`);
  return value;
}

/** Texto do contrato, com pelo menos 2 casas: `10.01`, `38.5115`. */
export function formatPrice(price: IntPrice): string {
  const whole = Math.floor(price / 100_000_000);
  const fraction = String(price % 100_000_000).padStart(SCALE_DIGITS, '0');
  let end = SCALE_DIGITS;
  while (end > 2 && fraction[end - 1] === '0') end--;
  return `${whole}.${fraction.slice(0, end)}`;
}

/** Taxa em inteiro de 8 casas (`0.03` → 3_000_000), para a conta exata dos túneis. */
export function parseRate(text: string): bigint {
  return BigInt(parsePrice(text));
}

export interface BandLimits {
  low: IntPrice;
  high: IntPrice;
}

/** Faixa `referência × (1 ± taxa)`, arredondada para dentro. A borda ainda está dentro do túnel. */
export function bandAround(reference: IntPrice, rate: bigint): BandLimits {
  const ref = BigInt(reference);
  return {
    low: Number((ref * (SCALE - rate) + SCALE - 1n) / SCALE),
    high: Number((ref * (SCALE + rate)) / SCALE),
  };
}

export const insideBand = (price: IntPrice, band: BandLimits | null): boolean =>
  band === null || (price >= band.low && price <= band.high);
