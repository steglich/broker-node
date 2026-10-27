import { Decimal, type Instant } from '@broker/domain-kernel';

/**
 * Cotação externa normalizada (`external_quote`, Brapi §9.1). Nenhum nome de campo da brapi passa
 * daqui para dentro (RN-BRP-002): valores decimais em texto, `quoteTime` em UTC.
 */
export interface ExternalQuote {
  /** Ticker devolvido pela fonte (o atual, se houve troca). */
  symbol: string;
  /** Ticker pedido; difere de `symbol` quando `changed = true` (RN-INS-033). */
  requestedSymbol: string;
  changed: boolean;
  lastPrice: string;
  quoteTime: Instant;
  open: string | null;
  high: string | null;
  low: string | null;
  previousClose: string | null;
  change: string | null;
  changePercent: string | null;
  volume: string | null;
  marketCap: string | null;
  week52Low: string | null;
  week52High: string | null;
  currency: 'BRL';
  shortName: string | null;
  longName: string | null;
  logoUrl: string | null;
}

/** Índices só têm fonte externa (RN-MD-020); o Ibovespa alimenta o circuit breaker (RN-MD-021). */
export const IBOVESPA = '^BVSP';
export const isIndex = (symbol: string) => symbol.startsWith('^');

export interface QuoteWarning {
  code: 'OUT_OF_DAY_RANGE' | 'CHANGE_MISMATCH';
  message: string;
}

/**
 * Avisos de consistência (Brapi §9.1): `low ≤ last ≤ high` com tolerância de 1 tick e a variação
 * recalculada a partir do fechamento anterior (divergência > 0,1 p.p.). São avisos, não erros: a
 * leitura segue.
 */
export function quoteWarnings(q: ExternalQuote, tickSize = '0.01'): QuoteWarning[] {
  const out: QuoteWarning[] = [];
  const last = new Decimal(q.lastPrice);
  const tick = new Decimal(tickSize);
  if (q.low !== null && last.lt(new Decimal(q.low).minus(tick)))
    out.push({
      code: 'OUT_OF_DAY_RANGE',
      message: `último ${q.lastPrice} abaixo da mínima ${q.low}`,
    });
  if (q.high !== null && last.gt(new Decimal(q.high).plus(tick)))
    out.push({
      code: 'OUT_OF_DAY_RANGE',
      message: `último ${q.lastPrice} acima da máxima ${q.high}`,
    });
  if (q.previousClose !== null && q.changePercent !== null) {
    const prev = new Decimal(q.previousClose);
    if (prev.gt(0)) {
      const computed = last.minus(prev).div(prev).times(100);
      if (computed.minus(q.changePercent).abs().gt('0.1'))
        out.push({
          code: 'CHANGE_MISMATCH',
          message: `variação informada ${q.changePercent}% difere da calculada ${computed.toFixed(3)}%`,
        });
    }
  }
  return out;
}

/** Variação relativa `|a − b| / b` (fração). */
export function relativeChange(price: string, anchor: string): Decimal {
  const a = new Decimal(anchor);
  return new Decimal(price).minus(a).abs().div(a);
}
