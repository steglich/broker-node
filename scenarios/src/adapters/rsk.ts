import { Decimal } from '@broker/domain-kernel';
import { decidePreTrade, decideWithdrawal } from '@broker/risk-service/domain/pretrade';
import {
  buildTrade,
  buyingPower,
  emptyProjection,
  replaceTrade,
  tradeKey,
  type AccountProjection,
} from '@broker/risk-service/domain/projection';
import type { ScenarioAdapter } from '../runner.js';

interface RskInputs {
  p2: string;
  vendas_do_dia?: string[];
  holds_dinheiro?: string[];
  /** Operações na ordem em que o Risco as serializa (RN-RSK-001). */
  operacoes?: ({ compra: { quantidade: number; preco: string } } | { saque: string })[];
}

const INSTRUMENT = 'instrumento';

/** Risco (RSK-*): poder de compra e decisões pelo domínio do risk-service (Risco §4, §11). */
export const rskAdapter: ScenarioAdapter = (raw, ctx) => {
  const inputs = raw as RskInputs;
  const at = ctx.clock.now();
  const p: AccountProjection = emptyProjection('conta');
  p.status = 'ACTIVE';
  p.settled = new Decimal(inputs.p2);
  p.d0 = p.settled;
  p.d1 = p.settled;
  p.d2 = p.settled;
  (inputs.vendas_do_dia ?? []).forEach((valor, i) => {
    const t = buildTrade({
      tradeId: `venda-${i}`,
      side: 'SELL',
      instrumentId: INSTRUMENT,
      quantity: 1,
      price: new Decimal(valor),
      tradingDate: at.businessDate().toString(),
      booked: false,
    });
    // Os cenários dão os valores líquidos: sem custos estimados.
    replaceTrade(p, tradeKey(t.tradeId, t.side), { ...t, estimatedCost: new Decimal(0) });
  });
  const hold = (id: string, amount: Decimal) =>
    p.holds.set(id, {
      id,
      accountId: p.accountId,
      type: 'WITHDRAWAL',
      resource: 'CASH',
      originalAmount: amount,
      remainingAmount: amount,
      originalQuantity: null,
      remainingQuantity: null,
      referenceType: 'WITHDRAWAL',
      referenceId: id,
      status: 'ACTIVE',
      createdAt: at,
      updatedAt: at,
    });
  (inputs.holds_dinheiro ?? []).forEach((valor, i) => hold(`hold-${i}`, new Decimal(valor)));

  const decisoes = (inputs.operacoes ?? []).map((op, i) => {
    if ('saque' in op) {
      const amount = new Decimal(op.saque);
      const d = decideWithdrawal(p, amount);
      if (d.decision === 'APPROVED') hold(`saque-${i}`, amount);
      return d.decision === 'APPROVED' ? 'APROVADO' : d.rejectCode;
    }
    const d = decidePreTrade(
      p,
      {
        orderId: `ordem-${i}`,
        instrumentId: INSTRUMENT,
        side: 'BUY',
        quantity: op.compra.quantidade,
        referencePrice: new Decimal(op.compra.preco),
        tradeIntent: 'NORMAL',
      },
      null,
    );
    if (d.decision === 'APPROVED') hold(`compra-${i}`, d.amount);
    return d.decision === 'APPROVED' ? 'APROVADO' : d.rejectCode;
  });

  return {
    bp_cash: buyingPower(p).toFixed(2),
    ...(decisoes.length > 0 ? { decisoes } : {}),
  };
};
