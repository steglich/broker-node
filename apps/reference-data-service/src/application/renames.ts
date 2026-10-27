import { BusinessDate } from '@broker/domain-kernel';
import { rename } from '../domain/symbol-history.js';
import { notFound, rule, type Operator, type ReferenceDeps } from './context.js';
import { instrumentState, view, type Instruments } from './instruments.js';
import type { BackofficeTask, ReferenceTx, TaskStatus } from './ports.js';

export const taskView = (t: BackofficeTask) => ({
  id: t.id,
  kind: t.kind,
  instrumentId: t.instrumentId,
  data: t.data,
  status: t.status,
  createdAt: t.createdAt.toString(),
  resolvedBy: t.resolvedBy,
  resolvedAt: t.resolvedAt?.toString() ?? null,
});

/**
 * Renomeação de tickers (Ativos §6, RN-INS-030..033): o market-data detecta a troca na brapi, o
 * serviço abre uma tarefa e o backoffice confirma; a confirmação renomeia mantendo o
 * `instrument_id` e grava o ticker antigo em `instrument_symbol_history`.
 */
export class Renames {
  constructor(
    private readonly d: ReferenceDeps,
    private readonly instruments: Instruments,
  ) {}

  /**
   * `market_data.symbol_rename_detected`: tarefa de confirmação para o instrumento conhecido
   * (RN-INS-033). Conversão com razão ≠ 1 vai como evento corporativo (RN-INS-031): a tarefa
   * avisa, mas a confirmação aqui recusa.
   */
  async onRenameDetected(
    tx: ReferenceTx,
    p: { oldSymbol: string; newSymbol: string; effectiveDate: string; conversionRatio?: string },
  ): Promise<boolean> {
    const i = await tx.instrumentBySymbol(p.oldSymbol);
    if (!i || i.status === 'DELISTED') return false;
    const ratio = p.conversionRatio ?? null;
    const conversion = ratio !== null && Number(ratio) !== 1;
    return this.instruments.openTask(tx, {
      kind: 'SYMBOL_RENAME_CONFIRMATION',
      dedupeKey: `rename:${i.id}:${p.newSymbol}:${p.effectiveDate}`,
      instrumentId: i.id,
      data: {
        oldSymbol: p.oldSymbol,
        newSymbol: p.newSymbol,
        effectiveDate: p.effectiveDate,
        conversionRatio: ratio,
        corporateAction: conversion,
      },
      message: conversion
        ? `Conversão ${p.oldSymbol} → ${p.newSymbol} (razão ${ratio}) em ${p.effectiveDate}: confirme como evento corporativo.`
        : `Ticker ${p.oldSymbol} → ${p.newSymbol} em ${p.effectiveDate}: confirme a renomeação.`,
    });
  }

  async tasks(status: TaskStatus | undefined) {
    return this.d.store.transaction(async (tx) => (await tx.tasks(status, 200)).map(taskView));
  }

  /** Confirma a tarefa de renomeação: renomeia e conclui a tarefa. */
  async confirm(op: Operator, taskId: string) {
    return this.d.store.transaction(async (tx) => {
      const t = await this.openTaskOf(tx, taskId);
      if (t.kind !== 'SYMBOL_RENAME_CONFIRMATION' || !t.instrumentId)
        throw rule('TASK_NOT_CONFIRMABLE', 'Esta tarefa não se confirma; conclua ou descarte.');
      const data = t.data as {
        newSymbol: string;
        effectiveDate: string;
        conversionRatio: string | null;
      };
      const instrument = await this.renameIn(tx, op, t.instrumentId, data);
      await tx.saveTask({
        ...t,
        status: 'DONE',
        resolvedBy: op.id,
        resolvedAt: this.d.clock.now(),
      });
      return { task: taskView({ ...t, status: 'DONE' }), instrument };
    });
  }

  /** Conclui (`DONE`) ou descarta (`DISMISSED`) uma tarefa sem efeito no cadastro. */
  async resolve(op: Operator, taskId: string, status: 'DONE' | 'DISMISSED') {
    return this.d.store.transaction(async (tx) => {
      const t = await this.openTaskOf(tx, taskId);
      const next = { ...t, status, resolvedBy: op.id, resolvedAt: this.d.clock.now() };
      await tx.saveTask(next);
      return taskView(next);
    });
  }

  /** Renomeação direta pelo backoffice (cadastro: BO_MARKET, sem aprovação). */
  async rename(
    op: Operator,
    instrumentId: string,
    input: { newSymbol: string; effectiveDate: string },
  ) {
    return this.d.store.transaction((tx) =>
      this.renameIn(tx, op, instrumentId, { ...input, conversionRatio: null }),
    );
  }

  async history(instrumentId: string) {
    return this.d.store.transaction(async (tx) =>
      (await tx.historyOf(instrumentId)).map((h) => ({
        symbol: h.symbol,
        validFrom: h.validFrom.toString(),
        validTo: h.validTo.toString(),
        conversionRatio: h.conversionRatio,
      })),
    );
  }

  private async renameIn(
    tx: ReferenceTx,
    op: Operator,
    instrumentId: string,
    input: { newSymbol: string; effectiveDate: string; conversionRatio: string | null },
  ) {
    const i = await tx.instrument(instrumentId, { forUpdate: true });
    if (!i) throw notFound('Instrumento inexistente.');
    const newSymbol = input.newSymbol.trim().toUpperCase();
    const taken = await tx.instrumentBySymbol(newSymbol);
    if (taken && taken.id !== i.id)
      throw rule('SYMBOL_ALREADY_EXISTS', `Já existe instrumento com o ticker ${newSymbol}.`);
    const [last] = await tx.historyOf(i.id);
    const currentSince = last ? last.validTo.plusDays(1) : i.createdAt.businessDate();
    const effectiveDate = BusinessDate.parse(input.effectiveDate);
    const { instrument, history } = rename(
      i,
      { newSymbol, effectiveDate, currentSince, conversionRatio: input.conversionRatio },
      this.d.clock.now(),
    );
    await tx.insertSymbolHistory(history);
    await tx.saveInstrument(instrument);
    await tx.publish(
      {
        type: 'instrument.symbol_changed',
        payload: {
          instrumentId: i.id,
          oldSymbol: i.symbol,
          newSymbol,
          effectiveDate: input.effectiveDate,
        },
      },
      i.id,
    );
    await tx.publish({ type: 'instrument.updated', payload: instrumentState(instrument) }, i.id);
    this.d.logger.info({
      event: 'instrument.renamed',
      instrumentId: i.id,
      from: i.symbol,
      to: newSymbol,
      operator: op.id,
    });
    return view(instrument);
  }

  private async openTaskOf(tx: ReferenceTx, id: string) {
    const t = await tx.task(id, { forUpdate: true });
    if (!t) throw notFound('Tarefa inexistente.');
    if (t.status !== 'OPEN') throw rule('TASK_NOT_OPEN', `A tarefa está ${t.status}.`);
    return t;
  }
}
