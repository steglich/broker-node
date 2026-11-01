import { Decimal } from '@broker/domain-kernel';
import { reduceHold, settleHold, type Hold } from '../domain/holds.js';
import {
  buildTrade,
  movePosition,
  replaceTrade,
  tradeKey,
  type AccountProjection,
  type Side,
  type UnbookedTrade,
} from '../domain/projection.js';
import { saveAndPublishHold, type RiskDeps } from './context.js';
import type { RiskTx, TradeRow } from './ports.js';

/** Estados terminais da ordem (Ordens §5.1). */
const TERMINAL = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
const ORDER_HOLD_TYPES = new Set<Hold['type']>(['ORDER_CASH', 'ORDER_POSITION']);

interface TradeExecuted {
  instrumentId: string;
  tradeId: string;
  price: string;
  quantity: number;
  buyOrderId: string;
  sellOrderId: string;
  buyAccountId: string;
  sellAccountId: string;
  buyParticipantType: string;
  sellParticipantType: string;
  tradingDate: string;
}

interface JournalPosted {
  type: string;
  referenceId: string;
  bookingDate: string;
  entries: { accountCode: string; ownerId: string | null; amount: string; sequence: number }[];
}

const signed = (side: Side, quantity: number) => (side === 'BUY' ? quantity : -quantity);

const holdOfOrder = (p: AccountProjection, orderId: string): Hold | undefined => {
  for (const h of p.holds.values())
    if (h.referenceId === orderId && ORDER_HOLD_TYPES.has(h.type)) return h;
  return undefined;
};

/**
 * Aplica os eventos à projeção (Risco §2, RN-RSK-003). Cada um relê a conta do banco dentro da
 * transação do consumidor: se o commit falhar, a nova tentativa parte do que foi gravado, não da
 * memória, e nada conta duas vezes. A linha da conta vem antes da fila dela, e numa ordem fixa quando
 * são duas contas: quem espera a linha não segura a fila de ninguém.
 */
export class Projector {
  constructor(private readonly d: RiskDeps) {}

  private async onAccount(
    tx: RiskTx,
    accountId: string,
    apply: (p: AccountProjection) => Promise<void>,
  ): Promise<void> {
    await tx.lockAccount(accountId);
    await this.d.memory.inTurn(accountId, async () => {
      const p = await tx.loadAccount(accountId);
      await apply(p);
      this.d.memory.put(p);
    });
  }

  // ---------------------------------------------------------------- saldos (ledger)

  async onBalanceChanged(
    tx: RiskTx,
    e: {
      accountId: string;
      settled: string;
      projected: { d0: string; d1: string; d2: string };
      lastSequence: number;
    },
  ): Promise<void> {
    await this.onAccount(tx, e.accountId, async (p) => {
      if (e.lastSequence < p.lastLedgerSeq) return;
      p.settled = new Decimal(e.settled);
      p.d0 = new Decimal(e.projected.d0);
      p.d1 = new Decimal(e.projected.d1);
      p.d2 = new Decimal(e.projected.d2);
      p.lastLedgerSeq = e.lastSequence;
      await tx.saveBalances(p);
    });
  }

  /**
   * Casa o lançamento com o negócio pelo `trade_id` (ADR-0003): o principal sai de `U` e entra em
   * `P2` no mesmo passo, sem esperar o `ledger.balance_changed` que vem depois. Separados, o poder de
   * compra ficaria alto no intervalo. Os custos da nota fazem o mesmo com a parte estimada.
   */
  async onJournalPosted(tx: RiskTx, e: JournalPosted): Promise<void> {
    if (e.type !== 'TRADE' && e.type !== 'FEES') return;
    const entries = e.entries
      .filter((x) => x.accountCode === 'CUST_CASH' && x.ownerId)
      .sort((a, b) => a.ownerId!.localeCompare(b.ownerId!));
    for (const entry of entries)
      await this.onAccount(tx, entry.ownerId!, async (p) => {
        const amount = new Decimal(entry.amount);
        if (e.type === 'TRADE') await this.bookPrincipal(tx, p, e.referenceId, amount);
        else await this.bookFees(tx, p, e.bookingDate);
        if (entry.sequence > p.lastLedgerSeq) {
          p.d2 = p.d2.plus(amount);
          p.lastLedgerSeq = entry.sequence;
          await tx.saveBalances(p);
        }
      });
  }

  private async bookPrincipal(
    tx: RiskTx,
    p: AccountProjection,
    tradeId: string,
    amount: Decimal,
  ): Promise<void> {
    // No ledger, comprar debita a `CUST_CASH` do comprador (Financeiro §9).
    const side: Side = amount.isNegative() ? 'BUY' : 'SELL';
    const key = tradeKey(tradeId, side);
    const current = p.trades.get(key);
    if (current) replaceTrade(p, key, { ...current, booked: true });
    const row = await tx.trade(tradeId, side);
    await tx.saveTrade(
      row
        ? { ...row, booked: true }
        : {
            tradeId,
            side,
            accountId: p.accountId,
            instrumentId: null,
            quantity: 0,
            notional: new Decimal(0),
            estimatedCost: new Decimal(0),
            tradingDate: '',
            executed: false,
            booked: true,
            feesBooked: false,
            busted: false,
          },
    );
  }

  private async bookFees(tx: RiskTx, p: AccountProjection, upTo: string): Promise<void> {
    for (const [key, t] of [...p.trades])
      if (t.tradingDate <= upTo) replaceTrade(p, key, { ...t, feesBooked: true });
    await tx.bookFees(p.accountId, upTo);
  }

  // ---------------------------------------------------------------- negócios (Motor)

  /**
   * O hold é reduzido aqui, junto com `U`, e não em `order.filled`: vindo depois de outro tópico, o
   * valor sairia do hold antes de entrar em `U`, com o poder de compra alto no intervalo. A ponta do
   * FMS não passa pelo Risco (RN-SMM-022).
   */
  async onTradeExecuted(tx: RiskTx, e: TradeExecuted): Promise<void> {
    const sides = [
      {
        side: 'BUY' as const,
        accountId: e.buyAccountId,
        orderId: e.buyOrderId,
        participant: e.buyParticipantType,
      },
      {
        side: 'SELL' as const,
        accountId: e.sellAccountId,
        orderId: e.sellOrderId,
        participant: e.sellParticipantType,
      },
    ]
      .filter((s) => s.participant !== 'MARKET_MAKER')
      .sort((a, b) => a.accountId.localeCompare(b.accountId));
    for (const s of sides)
      await this.onAccount(tx, s.accountId, async (p) => {
        const known = await tx.trade(e.tradeId, s.side);
        if (known?.executed) return;
        const trade = buildTrade({
          tradeId: e.tradeId,
          side: s.side,
          instrumentId: e.instrumentId,
          quantity: e.quantity,
          price: new Decimal(e.price),
          tradingDate: e.tradingDate,
          booked: known?.booked ?? false,
        });
        replaceTrade(p, tradeKey(e.tradeId, s.side), trade);
        await tx.saveTrade(toRow(trade, p.accountId));
        movePosition(p, e.instrumentId, signed(s.side, e.quantity));
        await tx.savePosition(p, e.instrumentId);
        await this.reduceOrderHold(tx, p, s.orderId, e.quantity, 'FILL');
      });
  }

  /** Negócio cancelado: o que ele moveu volta. O hold não, porque a ordem não volta ao livro (RN-BST-003). */
  async onTradeBusted(tx: RiskTx, e: { tradeId: string }): Promise<void> {
    for (const row of await tx.tradeSides(e.tradeId)) {
      if (!row.executed || row.busted) continue;
      await this.onAccount(tx, row.accountId, async (p) => {
        replaceTrade(p, tradeKey(row.tradeId, row.side), null);
        movePosition(p, row.instrumentId!, -signed(row.side, row.quantity));
        await tx.savePosition(p, row.instrumentId!);
        await tx.saveTrade({ ...row, busted: true });
      });
    }
  }

  private async reduceOrderHold(
    tx: RiskTx,
    p: AccountProjection,
    orderId: string,
    quantity: number,
    cause: 'FILL' | 'CANCEL',
  ): Promise<void> {
    const hold = holdOfOrder(p, orderId);
    if (!hold || quantity === 0) return;
    const next = reduceHold(hold, quantity, cause, this.d.clock.now());
    await saveAndPublishHold(tx, next);
    if (next.status === 'ACTIVE') p.holds.set(next.id, next);
    else p.holds.delete(next.id);
  }

  // ---------------------------------------------------------------- ordens (OMS)

  async onOrderUpdated(
    tx: RiskTx,
    e: { orderId: string; accountId: string; status: string },
  ): Promise<void> {
    await this.onAccount(tx, e.accountId, async (p) => {
      if (TERMINAL.has(e.status)) {
        await this.closeOrder(tx, p, e.orderId, e.status);
        if (e.status === 'REJECTED') await this.releaseOrderHold(tx, p, e.orderId);
      } else if (await tx.openReference('ORDER', e.orderId, e.accountId)) {
        p.openOrders.add(e.orderId);
      }
    });
  }

  /** Cancelamento ou expiração: libera só a parte cancelada, comutativo com as execuções (RN-HLD-004). */
  async onOrderClosed(
    tx: RiskTx,
    e: { orderId: string; accountId: string; canceledQuantity: number },
    status: 'CANCELED' | 'EXPIRED',
  ): Promise<void> {
    await this.onAccount(tx, e.accountId, async (p) => {
      await this.closeOrder(tx, p, e.orderId, status);
      await this.reduceOrderHold(tx, p, e.orderId, e.canceledQuantity, 'CANCEL');
    });
  }

  /** Recusada pelo OMS ou pelo Motor, inclusive depois de o OMS desistir por timeout (RN-FLX-001). */
  async onOrderRejected(tx: RiskTx, e: { orderId: string; accountId: string }): Promise<void> {
    await this.onAccount(tx, e.accountId, async (p) => {
      await this.closeOrder(tx, p, e.orderId, 'REJECTED');
      await this.releaseOrderHold(tx, p, e.orderId);
    });
  }

  private async closeOrder(tx: RiskTx, p: AccountProjection, orderId: string, status: string) {
    await tx.closeReference('ORDER', orderId, p.accountId, status, this.d.clock.now());
    p.openOrders.delete(orderId);
  }

  private async releaseOrderHold(tx: RiskTx, p: AccountProjection, orderId: string) {
    const hold = holdOfOrder(p, orderId);
    if (!hold) return;
    await saveAndPublishHold(tx, settleHold(hold, 'RELEASED', this.d.clock.now()));
    p.holds.delete(hold.id);
  }

  // ---------------------------------------------------------------- saques, conta e preços

  /** Referência terminal do hold de saque: quem desfaz é o ledger, a reconciliação é a rede (RN-HLD-007). */
  async onWithdrawalClosed(
    tx: RiskTx,
    e: { withdrawalId: string; accountId: string },
    status: string,
  ): Promise<void> {
    await tx.closeReference('WITHDRAWAL', e.withdrawalId, e.accountId, status, this.d.clock.now());
  }

  async onAccountStatus(tx: RiskTx, accountId: string, status: string): Promise<void> {
    await this.onAccount(tx, accountId, async (p) => {
      p.status = status;
      await tx.saveStatus(p);
    });
  }

  async onReferencePrice(
    tx: RiskTx,
    e: { instrumentId: string; price: string; seq: number },
  ): Promise<void> {
    const price = new Decimal(e.price);
    if (await tx.savePrice(e.instrumentId, price, e.seq))
      this.d.memory.prices.set(e.instrumentId, { price, seq: e.seq });
  }
}

const toRow = (t: UnbookedTrade, accountId: string): TradeRow => ({
  ...t,
  accountId,
  executed: true,
  busted: false,
});
