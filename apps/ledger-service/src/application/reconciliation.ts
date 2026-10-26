import type { BusinessDate } from '@broker/domain-kernel';
import type { LedgerDeps } from './context.js';
import type { BankTransaction, Divergence, ReconciliationRow } from './ports.js';

/** Margem para o que acabou de acontecer: um PIX dos últimos minutos ainda pode estar sendo lançado. */
const SETTLE_MARGIN_MS = 5 * 60_000;

/**
 * Reconciliação PIX diária (RN-PIXS-002): as transações do Banco Simulado contra o que o ledger
 * registrou (`pix_transaction_ref` e as entradas de `HOUSE_PIX_RESERVE`). As janelas são contínuas:
 * cada execução começa onde a anterior parou, então fim de semana e feriado (sem rotina) entram na
 * próxima. Divergência → alerta crítico.
 */
export class PixReconciliation {
  constructor(private readonly d: LedgerDeps) {}

  async run(businessDate: BusinessDate): Promise<ReconciliationRow> {
    const existing = await this.d.store.transaction((tx) => tx.reconciliation(businessDate));
    if (existing) return existing; // rotina repetida (RN-ROT-001)
    const last = await this.d.store.transaction((tx) => tx.lastReconciliation());
    const now = this.d.clock.now();
    const from = last?.periodTo ?? businessDate.atLocalTime('00:00');
    const margin = now.plusMillis(-SETTLE_MARGIN_MS);
    const to = margin.isAfter(from) ? margin : from;

    const bank = await this.d.pix.transactions(from, to);
    const divergences: Divergence[] = [];
    const add = (kind: Divergence['kind'], endToEndId: string, detail: string) =>
      divergences.push({ kind, endToEndId, detail });

    const seen = new Map<string, BankTransaction>(bank.map((t) => [t.endToEndId, t]));
    await this.d.store.transaction(async (tx) => {
      for (const t of bank) {
        const ref = await tx.pixRef(t.endToEndId);
        if (!t.completed) {
          if (ref?.journalId)
            add(
              'LEDGER_WITHOUT_PIX',
              t.endToEndId,
              'Lançado no ledger, mas o PIX não foi realizado.',
            );
          continue;
        }
        if (!ref) {
          add(
            'PIX_WITHOUT_LEDGER',
            t.endToEndId,
            `${t.kind} de R$ ${t.amount.toString()} sem registro no ledger.`,
          );
          continue;
        }
        if (!ref.amount.equals(t.amount))
          add(
            'AMOUNT_MISMATCH',
            t.endToEndId,
            `Banco R$ ${t.amount.toString()}, ledger R$ ${ref.amount.toString()}.`,
          );
        if (t.kind === 'CHARGE_PAYMENT') {
          if (ref.journalId && t.refunds.length > 0)
            add('CREDITED_AND_REFUNDED', t.endToEndId, 'Depósito creditado e também devolvido.');
          if (!ref.journalId && t.refunds.length === 0)
            add('REFUND_PENDING', t.endToEndId, 'Depósito não creditado e ainda não devolvido.');
        } else if (t.kind === 'TRANSFER' && !ref.journalId) {
          add('PIX_WITHOUT_LEDGER', t.endToEndId, 'Saque enviado sem lançamento.');
        }
      }

      // O lado do ledger: toda entrada na reserva PIX precisa de um PIX concluído no banco.
      for (const e of await tx.reserveEntriesBetween(from, to)) {
        if (!e.endToEndId) {
          add(
            'LEDGER_WITHOUT_PIX',
            '-',
            `Journal ${e.journalId} na reserva PIX sem PIX associado.`,
          );
          continue;
        }
        const t = seen.get(e.endToEndId) ?? (await this.d.pix.transaction(e.endToEndId));
        if (!t || !t.completed)
          add(
            'LEDGER_WITHOUT_PIX',
            e.endToEndId,
            `Journal ${e.journalId} sem PIX concluído no banco.`,
          );
        else if (!t.amount.equals(e.amount.isNegative() ? e.amount.negated() : e.amount))
          add(
            'AMOUNT_MISMATCH',
            e.endToEndId,
            `Banco R$ ${t.amount.toString()}, reserva R$ ${e.amount.toString()}.`,
          );
      }
    });

    const row: ReconciliationRow = {
      id: this.d.newId(),
      businessDate,
      periodFrom: from,
      periodTo: to,
      status: divergences.length > 0 ? 'DIVERGENT' : 'OK',
      checked: bank.length,
      divergences,
    };
    await this.d.store.transaction((tx) => tx.insertReconciliation(row, now));
    if (divergences.length > 0) {
      const alert = {
        kind: 'PIX_RECONCILIATION_DIVERGENCE' as const,
        businessDate: businessDate.toString(),
        detail: `${divergences.length} divergência(s): ${divergences
          .slice(0, 5)
          .map((x) => `${x.kind} ${x.endToEndId}`)
          .join('; ')}`,
      };
      this.d.logger.error(
        { event: 'ledger.critical_alert', severity: 'critical', ...alert, divergences },
        'reconciliação PIX com divergência',
      );
      this.d.onCriticalAlert?.(alert);
    }
    return row;
  }
}
