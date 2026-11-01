import { Decimal, roundDecimal } from '@broker/domain-kernel';

export type AuctionType = 'OPENING' | 'CLOSING' | 'VOLATILITY' | 'REOPENING';
/**
 * `OPEN`: aceitando ordens. `HELD`: prorrogações esgotadas e mantido, à espera do backoffice.
 * `CONCLUDING`: a sessão mandou encerrar e o Motor conclui na janela aleatória (RN-AUC-033).
 * `COMPLETED`: o Motor concluiu. `CANCELED`: suspensão ou fase seguinte encerrou sem execução.
 */
export type AuctionStatus = 'OPEN' | 'HELD' | 'CONCLUDING' | 'COMPLETED' | 'CANCELED';

/** RN-AUC-003: o que fazer depois da última prorrogação. */
export type AuctionExtensionPolicy = 'CONCLUDE_AT_BAND' | 'KEEP_OPEN';

export interface PriceLimit {
  min: string;
  max: string;
}

export type AuctionDecision =
  | { kind: 'CONCLUDE'; priceLimit?: PriceLimit; alert: boolean }
  | { kind: 'EXTEND' }
  | { kind: 'HOLD'; alert: true };

/** O preço está fora de ±`bandPct` da referência? O limite exato ainda está dentro do túnel. */
export function outsideStaticBand(price: Decimal, reference: Decimal, bandPct: Decimal): boolean {
  return price.minus(reference).abs().greaterThan(reference.times(bandPct));
}

/** Limites do túnel estático, arredondados para dentro dele. */
export function staticBandLimits(reference: Decimal, bandPct: Decimal): PriceLimit {
  return {
    min: roundDecimal(reference.times(new Decimal(1).minus(bandPct)), 4, 'CEIL').toFixed(4),
    max: roundDecimal(reference.times(new Decimal(1).plus(bandPct)), 4, 'FLOOR').toFixed(4),
  };
}

/** RN-AUC-003: decisão no fim previsto do leilão. */
export function decideAuctionEnd(input: {
  /** `null` sem preço teórico (livro não cruzado): não há o que comparar. */
  theoreticalPrice: Decimal | null;
  /** `null` num instrumento ainda sem fechamento conhecido. */
  bandReferencePrice: Decimal | null;
  staticBandPct: Decimal;
  extensions: number;
  maxExtensions: number;
  policy: AuctionExtensionPolicy;
}): AuctionDecision {
  const { theoreticalPrice: price, bandReferencePrice: reference } = input;
  if (!price || !reference || !outsideStaticBand(price, reference, input.staticBandPct))
    return { kind: 'CONCLUDE', alert: false };
  if (input.extensions < input.maxExtensions) return { kind: 'EXTEND' };
  if (input.policy === 'KEEP_OPEN') return { kind: 'HOLD', alert: true };
  return {
    kind: 'CONCLUDE',
    priceLimit: staticBandLimits(reference, input.staticBandPct),
    alert: true,
  };
}
