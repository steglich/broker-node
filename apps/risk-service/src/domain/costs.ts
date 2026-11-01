import { Decimal, roundDecimal } from '@broker/domain-kernel';

/**
 * Tabela de referência de Custos §3, provisória (RN-HLD-003): o `fee_schedule` com vigência e a API
 * de estimativa do Clearing a substituem na Fase 3. A corretagem padrão é zero, e o ISS incide sobre
 * ela. A liquidação usa a alíquota de swing mesmo em day trade, porque é a maior e a classificação
 * final só sai no fechamento (RN-RSK-004).
 */
const TRADING_FEE = new Decimal('0.00005');
const SETTLEMENT_FEE = new Decimal('0.00025');
const SAFETY_MARGIN = new Decimal('1.10');

export const cents = (d: Decimal): Decimal => roundDecimal(d, 2, 'HALF_UP');

/** Custos estimados de um volume, arredondados por componente (RN-FEE-030). */
export const estimatedCosts = (notional: Decimal): Decimal =>
  cents(notional.times(TRADING_FEE)).plus(cents(notional.times(SETTLEMENT_FEE)));

/** Hold de compra: `quantidade × preço + custos × 1,10` (RN-HLD-002, RN-HLD-003). */
export function buyHoldAmount(quantity: number, price: Decimal): Decimal {
  const notional = price.times(quantity);
  return cents(notional.plus(estimatedCosts(cents(notional)).times(SAFETY_MARGIN)));
}
