import type { Clock } from '@broker/clock';
import { Decimal, Instant } from '@broker/domain-kernel';
import { inTransaction } from '@broker/persistence';
import { businessRule, conflict, HttpError, notFound } from '@broker/service-kit';
import type { SimulatorControl } from '@broker/simulator-kit';
import type { WebhookDispatcher } from '@broker/webhooks';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { brCode, cpfFromBase, endToEndId, maskName } from './identifiers.js';

/** Cenários forçáveis do PIX (RN-PIXS-003). A indisponibilidade de 10 min é do simulator-kit. */
export type PixScenario =
  | 'DUPLICATE_PAYMENT_WEBHOOK'
  | 'DELAYED_WEBHOOK'
  | 'KEY_NOT_FOUND'
  | 'INSUFFICIENT_BALANCE'
  | 'SEND_REJECTED';

export const PIX_SCENARIOS: ReadonlyArray<{ id: PixScenario; label: string }> = [
  {
    id: 'DUPLICATE_PAYMENT_WEBHOOK',
    label: 'Próximo pagamento: webhook entregue duas vezes (mesmo endToEndId)',
  },
  { id: 'DELAYED_WEBHOOK', label: 'Próximo pagamento: webhook só depois da expiração da cobrança' },
  { id: 'KEY_NOT_FOUND', label: 'Próximo envio: chave inexistente' },
  { id: 'INSUFFICIENT_BALANCE', label: 'Próximo envio: saldo insuficiente na conta da corretora' },
  { id: 'SEND_REJECTED', label: 'Próximo envio: falha definitiva (PIX_REJEITADO)' },
];

export type AccountKind = 'CLIENTE' | 'TERCEIRO' | 'CORRETORA';

export interface BankOptions {
  db: Kysely<unknown>;
  clock: Clock;
  dispatcher: WebhookDispatcher;
  control: SimulatorControl<PixScenario>;
  newId: () => string;
  /** Endpoint da corretora que recebe `pix.recebido`. */
  webhookUrl: string;
  /** Saldo de abertura quando a chamada não informa (§2.1). */
  defaultInitialBalance: string;
  broker: { cnpj: string; name: string; initialBalance: string };
}

interface AccountRow {
  id: string;
  branch: string;
  number: string;
  kind: AccountKind;
  tax_id: string;
  holder_name: string;
  balance: Decimal;
  created_at: Date;
}

interface ChargeRow {
  txid: string;
  account_id: string;
  amount: Decimal;
  expires_in_s: number;
  debtor_tax_id: string | null;
  debtor_name: string | null;
  payer_message: string | null;
  copy_paste: string;
  request_hash: string;
  paid_at: Date | null;
  created_at: Date;
}

interface PixRow {
  end_to_end_id: string;
  kind: 'COBRANCA' | 'ENVIO' | 'DEVOLUCAO';
  status: 'CONCLUIDO' | 'NAO_REALIZADO';
  failure_code: string | null;
  txid: string | null;
  send_id: string | null;
  refund_id: string | null;
  original_e2e: string | null;
  payer_account_id: string;
  payee_account_id: string | null;
  payee_key: string | null;
  amount: Decimal;
  description: string | null;
  created_at: Date;
}

const money = (d: Decimal) => d.toFixed(2);
const party = (a: Pick<AccountRow, 'tax_id' | 'holder_name'>) =>
  a.tax_id.length === 14
    ? { cnpj: a.tax_id, nome: a.holder_name }
    : { cpf: a.tax_id, nome: a.holder_name };
const sha256 = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Contas de terceiros semeadas: outros CPFs, para testar a recusa por titularidade (§2.1). */
const THIRD_PARTIES = [
  { base: '529982247', name: 'Terceiro Um da Silva' },
  { base: '111444777', name: 'Terceira Dois Souza' },
];

/**
 * O Banco Simulado. Toda operação que mexe em saldo roda numa transação; o débito é um
 * `UPDATE ... WHERE balance >= valor`, então duas operações concorrentes nunca gastam o mesmo saldo.
 */
export class PixBank {
  constructor(private readonly o: BankOptions) {}

  // ------------------------------------------------------------------ contas

  /** Cria (se faltar) a conta da corretora, que espelha `HOUSE_PIX_RESERVE`, e as de terceiros. */
  async seed(): Promise<void> {
    const { broker } = this.o;
    await this.openAccount({
      cpf: broker.cnpj,
      nome: broker.name,
      tipo: 'CORRETORA',
      saldoInicial: broker.initialBalance,
    });
    for (const t of THIRD_PARTIES) {
      await this.openAccount({ cpf: cpfFromBase(t.base), nome: t.name, tipo: 'TERCEIRO' });
    }
  }

  async openAccount(input: {
    cpf: string;
    nome: string;
    tipo?: AccountKind;
    saldoInicial?: string;
  }): Promise<{ created: boolean; account: Awaited<ReturnType<PixBank['getAccount']>> }> {
    const kind = input.tipo ?? 'CLIENTE';
    const id = this.o.newId();
    const now = this.o.clock.now().toString();
    const created = await inTransaction(this.o.db, async (trx) => {
      const inserted = await sql<{ id: string }>`
        INSERT INTO account (id, branch, number, kind, tax_id, holder_name, balance, created_at)
        VALUES (${id}, '0001', nextval('account_number_seq')::text, ${kind}, ${input.cpf}, ${input.nome},
                ${input.saldoInicial ?? this.o.defaultInitialBalance}, ${now})
        ON CONFLICT (kind, tax_id) DO NOTHING RETURNING id`.execute(trx);
      if (inserted.rows.length === 0) return false;
      const taxKey = kind === 'CORRETORA' ? 'CNPJ' : 'CPF';
      // A chave CPF é única no banco: um CPF com conta de cliente e de terceiro fica só com a primeira.
      await sql`
        INSERT INTO pix_key (key, key_type, account_id, created_at)
        VALUES (${input.cpf}, ${taxKey}, ${id}, ${now}), (${randomUUID()}, 'EVP', ${id}, ${now})
        ON CONFLICT (key) DO NOTHING`.execute(trx);
      return true;
    });
    const row = (
      await sql<{
        id: string;
      }>`SELECT id FROM account WHERE kind = ${kind} AND tax_id = ${input.cpf}`.execute(this.o.db)
    ).rows[0]!;
    return { created, account: await this.getAccount(row.id) };
  }

  async listAccounts() {
    const { rows } = await sql<{
      id: string;
    }>`SELECT id FROM account ORDER BY created_at, number`.execute(this.o.db);
    return Promise.all(rows.map((r) => this.getAccount(r.id)));
  }

  async getAccount(id: string) {
    const account = (
      await sql<AccountRow>`SELECT * FROM account WHERE id = ${id}`.execute(this.o.db)
    ).rows[0];
    if (!account) throw notFound('Conta inexistente.');
    const keys = await sql<{ key: string; key_type: 'CPF' | 'CNPJ' | 'EVP' }>`
      SELECT key, key_type FROM pix_key WHERE account_id = ${id} ORDER BY key_type, key`.execute(
      this.o.db,
    );
    return {
      id: account.id,
      agencia: account.branch,
      numero: account.number,
      tipo: account.kind,
      titular: party(account),
      saldo: money(account.balance),
      chaves: keys.rows.map((k) => ({ chave: k.key, tipo: k.key_type })),
      criadaEm: account.created_at.toISOString(),
    };
  }

  async brokerAccount(): Promise<AccountRow> {
    const row = (
      await sql<AccountRow>`SELECT * FROM account WHERE kind = 'CORRETORA' AND tax_id = ${this.o.broker.cnpj}`.execute(
        this.o.db,
      )
    ).rows[0];
    if (!row) throw new Error('conta da corretora não semeada (rode seed())');
    return row;
  }

  async lookupKey(key: string) {
    const row = (
      await sql<AccountRow & { key_type: 'CPF' | 'CNPJ' | 'EVP' }>`
        SELECT a.*, k.key_type FROM pix_key k JOIN account a ON a.id = k.account_id WHERE k.key = ${key}`.execute(
        this.o.db,
      )
    ).rows[0];
    if (!row) throw new HttpError(404, 'CHAVE_INEXISTENTE', 'Chave PIX não encontrada.');
    const holder = party(row);
    return {
      chave: key,
      tipo: row.key_type,
      titular: {
        ...('cpf' in holder ? { cpf: holder.cpf } : { cnpj: holder.cnpj }),
        nomeMascarado: maskName(row.holder_name),
      },
    };
  }

  // ------------------------------------------------------------------ cobranças

  async createCharge(
    txid: string,
    input: {
      calendario: { expiracao: number };
      valor: { original: string };
      devedor?: { cpf: string; nome: string };
      solicitacaoPagador?: string;
    },
  ): Promise<{ created: boolean; charge: Awaited<ReturnType<PixBank['getCharge']>> }> {
    const broker = await this.brokerAccount();
    const brokerKey = this.o.broker.cnpj;
    const hash = sha256(input);
    const inserted = await sql<{ txid: string }>`
      INSERT INTO charge (txid, account_id, amount, expires_in_s, debtor_tax_id, debtor_name, payer_message,
                          copy_paste, request_hash, created_at)
      VALUES (${txid}, ${broker.id}, ${input.valor.original}, ${input.calendario.expiracao},
              ${input.devedor?.cpf ?? null}, ${input.devedor?.nome ?? null}, ${input.solicitacaoPagador ?? null},
              ${brCode({ key: brokerKey, amount: input.valor.original, merchant: 'SIMULADO CORRETORA', city: 'SAO PAULO', txid })},
              ${hash}, ${this.o.clock.now().toString()})
      ON CONFLICT (txid) DO NOTHING RETURNING txid`.execute(this.o.db);
    if (inserted.rows.length === 0) {
      const existing = await this.chargeRow(txid);
      if (existing.request_hash !== hash)
        throw conflict('TXID_EM_USO', 'O txid já existe com outro conteúdo.');
      return { created: false, charge: await this.getCharge(txid) };
    }
    return { created: true, charge: await this.getCharge(txid) };
  }

  private async chargeRow(
    txid: string,
    db: Kysely<unknown> = this.o.db,
    lock = false,
  ): Promise<ChargeRow> {
    const row = lock
      ? (await sql<ChargeRow>`SELECT * FROM charge WHERE txid = ${txid} FOR UPDATE`.execute(db))
          .rows[0]
      : (await sql<ChargeRow>`SELECT * FROM charge WHERE txid = ${txid}`.execute(db)).rows[0];
    if (!row) throw notFound('Cobrança inexistente.');
    return row;
  }

  private expiresAt(charge: ChargeRow): Instant {
    return Instant.ofEpochMillis(charge.created_at.getTime() + charge.expires_in_s * 1000);
  }

  private chargeStatus(charge: ChargeRow) {
    if (charge.paid_at) return 'CONCLUIDA' as const;
    return this.o.clock.now().isBefore(this.expiresAt(charge))
      ? ('ATIVA' as const)
      : ('REMOVIDA_POR_EXPIRACAO' as const);
  }

  async getCharge(txid: string) {
    const c = await this.chargeRow(txid);
    const paid = await sql<PixRow>`
      SELECT * FROM pix_transaction WHERE txid = ${txid} AND kind = 'COBRANCA' ORDER BY created_at`.execute(
      this.o.db,
    );
    return {
      txid: c.txid,
      status: this.chargeStatus(c),
      calendario: { criacao: c.created_at.toISOString(), expiracao: c.expires_in_s },
      valor: { original: money(c.amount) },
      chave: this.o.broker.cnpj,
      ...(c.debtor_tax_id ? { devedor: { cpf: c.debtor_tax_id, nome: c.debtor_name! } } : {}),
      ...(c.payer_message ? { solicitacaoPagador: c.payer_message } : {}),
      pixCopiaECola: c.copy_paste,
      pix: paid.rows.map((p) => ({
        endToEndId: p.end_to_end_id,
        valor: money(p.amount),
        horario: p.created_at.toISOString(),
      })),
    };
  }

  async listCharges(limit = 50) {
    const { rows } = await sql<{
      txid: string;
    }>`SELECT txid FROM charge ORDER BY created_at DESC LIMIT ${limit}`.execute(this.o.db);
    return Promise.all(rows.map((r) => this.getCharge(r.txid)));
  }

  /**
   * Pagamento de cobrança pela conta escolhida (cliente na UI, ou testes pela API). Debita o pagador,
   * credita a corretora e agenda o webhook `pix.recebido` com o pagador REAL (que pode não ser o
   * devedor: o núcleo usa isso para devolver PIX de terceiros).
   */
  async payCharge(txid: string, payerAccountId: string) {
    const e2e = await inTransaction(this.o.db, async (trx) => {
      const charge = await this.chargeRow(txid, trx, true);
      const status = this.chargeStatus(charge);
      if (status === 'CONCLUIDA') throw businessRule('COBRANCA_JA_PAGA', 'A cobrança já foi paga.');
      if (status === 'REMOVIDA_POR_EXPIRACAO')
        throw businessRule('COBRANCA_EXPIRADA', 'A cobrança expirou.');
      const payer = (
        await sql<AccountRow>`SELECT * FROM account WHERE id = ${payerAccountId}`.execute(trx)
      ).rows[0];
      if (!payer) throw notFound('Conta pagadora inexistente.');
      if (payer.id === charge.account_id)
        throw businessRule('CONTA_INVALIDA', 'A conta pagadora é a recebedora.');
      await this.debit(trx, payer.id, charge.amount);
      await sql`UPDATE account SET balance = balance + ${charge.amount} WHERE id = ${charge.account_id}`.execute(
        trx,
      );
      const now = this.o.clock.now();
      const id = endToEndId(now, await this.nextSequence(trx));
      await sql`
        INSERT INTO pix_transaction (end_to_end_id, kind, status, txid, payer_account_id, payee_account_id, amount, created_at)
        VALUES (${id}, 'COBRANCA', 'CONCLUIDO', ${txid}, ${payer.id}, ${charge.account_id}, ${charge.amount}, ${now.toString()})`.execute(
        trx,
      );
      await sql`UPDATE charge SET paid_at = ${now.toString()} WHERE txid = ${txid}`.execute(trx);

      const body = {
        pix: [
          {
            endToEndId: id,
            txid,
            valor: money(charge.amount),
            horario: now.toString(),
            pagador: party(payer),
          },
        ],
      };
      // Webhook atrasado: só sai 1 min depois da expiração da cobrança (RN-PIXS-003).
      const delayed = this.o.control.consume('DELAYED_WEBHOOK');
      const notBefore = delayed ? this.expiresAt(charge).plusMillis(60_000) : undefined;
      const copies = this.o.control.consume('DUPLICATE_PAYMENT_WEBHOOK') ? 2 : 1;
      for (let i = 0; i < copies; i++) {
        await this.o.dispatcher.enqueue(trx, {
          eventId: id,
          eventType: 'pix.recebido',
          url: this.o.webhookUrl,
          body,
          ...(notBefore ? { notBefore } : {}),
        });
      }
      return id;
    });
    return this.getPix(e2e);
  }

  // ------------------------------------------------------------------ envio (saque)

  /**
   * Envio da conta da corretora para uma chave. Repetir o mesmo `idEnvio` devolve o resultado
   * original, inclusive a recusa: o envio é idempotente pelo identificador do cliente.
   */
  async sendPix(input: {
    idEnvio: string;
    valor: string;
    chave: string;
    cpfRecebedor?: string;
    descricao?: string;
  }) {
    const existing = (
      await sql<PixRow>`SELECT * FROM pix_transaction WHERE send_id = ${input.idEnvio}`.execute(
        this.o.db,
      )
    ).rows[0];
    if (existing) return { created: false, pix: await this.pixOrFailure(existing.end_to_end_id) };

    const e2e = await inTransaction(this.o.db, async (trx) => {
      const broker = await this.brokerAccount();
      const amount = new Decimal(input.valor);
      const now = this.o.clock.now();
      const id = endToEndId(now, await this.nextSequence(trx));
      const payee = (
        await sql<AccountRow>`
          SELECT a.* FROM pix_key k JOIN account a ON a.id = k.account_id WHERE k.key = ${input.chave}`.execute(
          trx,
        )
      ).rows[0];

      let failure: string | null = null;
      if (this.o.control.consume('SEND_REJECTED')) failure = 'PIX_REJEITADO';
      else if (this.o.control.consume('KEY_NOT_FOUND') || !payee) failure = 'CHAVE_INEXISTENTE';
      else if (input.cpfRecebedor && payee.tax_id !== input.cpfRecebedor)
        failure = 'TITULARIDADE_DIVERGENTE';
      else if (this.o.control.consume('INSUFFICIENT_BALANCE')) failure = 'SALDO_INSUFICIENTE';
      else if (!(await this.tryDebit(trx, broker.id, amount))) failure = 'SALDO_INSUFICIENTE';

      if (!failure)
        await sql`UPDATE account SET balance = balance + ${amount} WHERE id = ${payee!.id}`.execute(
          trx,
        );
      await sql`
        INSERT INTO pix_transaction (end_to_end_id, kind, status, failure_code, send_id, payer_account_id,
                                     payee_account_id, payee_key, amount, description, created_at)
        VALUES (${id}, 'ENVIO', ${failure ? 'NAO_REALIZADO' : 'CONCLUIDO'}, ${failure}, ${input.idEnvio}, ${broker.id},
                ${failure ? null : payee!.id}, ${input.chave}, ${amount}, ${input.descricao ?? null}, ${now.toString()})`.execute(
        trx,
      );
      return id;
    });
    return { created: true, pix: await this.pixOrFailure(e2e) };
  }

  /** Um envio recusado vira `422` com o código, mesmo na repetição do `idEnvio`. */
  private async pixOrFailure(e2e: string) {
    const pix = await this.getPix(e2e);
    if (pix.status === 'NAO_REALIZADO') {
      throw businessRule(pix.motivo!, `PIX não realizado: ${pix.motivo}.`, { endToEndId: e2e });
    }
    return pix;
  }

  // ------------------------------------------------------------------ devolução

  async refund(originalE2e: string, refundId: string, valor: string) {
    const existing = (
      await sql<PixRow>`SELECT * FROM pix_transaction WHERE original_e2e = ${originalE2e} AND kind = 'DEVOLUCAO'`.execute(
        this.o.db,
      )
    ).rows[0];
    if (existing) {
      if (existing.refund_id !== refundId)
        throw conflict('PIX_JA_DEVOLVIDO', 'Este PIX já foi devolvido com outro id.');
      return { created: false, refund: this.refundView(existing) };
    }
    const row = await inTransaction(this.o.db, async (trx) => {
      const original = (
        await sql<PixRow>`SELECT * FROM pix_transaction WHERE end_to_end_id = ${originalE2e} FOR UPDATE`.execute(
          trx,
        )
      ).rows[0];
      if (!original) throw notFound('PIX inexistente.');
      const broker = await this.brokerAccount();
      if (
        original.kind !== 'COBRANCA' ||
        original.status !== 'CONCLUIDO' ||
        original.payee_account_id !== broker.id
      ) {
        throw businessRule(
          'PIX_NAO_DEVOLVIVEL',
          'Só um PIX recebido pela corretora pode ser devolvido.',
        );
      }
      if (!new Decimal(valor).equals(original.amount)) {
        throw businessRule(
          'VALOR_DEVOLUCAO_INVALIDO',
          `A devolução é total: ${money(original.amount)}.`,
        );
      }
      await this.debit(trx, broker.id, original.amount);
      await sql`UPDATE account SET balance = balance + ${original.amount} WHERE id = ${original.payer_account_id}`.execute(
        trx,
      );
      const now = this.o.clock.now();
      const id = endToEndId(now, await this.nextSequence(trx));
      return (
        await sql<PixRow>`
          INSERT INTO pix_transaction (end_to_end_id, kind, status, refund_id, original_e2e, payer_account_id,
                                       payee_account_id, amount, created_at)
          VALUES (${id}, 'DEVOLUCAO', 'CONCLUIDO', ${refundId}, ${originalE2e}, ${broker.id},
                  ${original.payer_account_id}, ${original.amount}, ${now.toString()})
          RETURNING *`.execute(trx)
      ).rows[0]!;
    });
    return { created: true, refund: this.refundView(row) };
  }

  private refundView(r: PixRow) {
    return {
      id: r.refund_id!,
      rtrId: r.end_to_end_id,
      valor: money(r.amount),
      horario: r.created_at.toISOString(),
      status: 'DEVOLVIDO' as const,
    };
  }

  // ------------------------------------------------------------------ consulta

  async getPix(e2e: string) {
    const row = (
      await sql<PixRow>`SELECT * FROM pix_transaction WHERE end_to_end_id = ${e2e}`.execute(
        this.o.db,
      )
    ).rows[0];
    if (!row) throw notFound('PIX inexistente.');
    return this.pixView(row);
  }

  async listPix(filter: { txid?: string; inicio?: string; fim?: string; limit?: number }) {
    const { rows } = await sql<PixRow>`
      SELECT * FROM pix_transaction
      WHERE (${filter.txid ?? null}::text IS NULL OR txid = ${filter.txid ?? null})
        AND (${filter.inicio ?? null}::timestamptz IS NULL OR created_at >= ${filter.inicio ?? null})
        AND (${filter.fim ?? null}::timestamptz IS NULL OR created_at < ${filter.fim ?? null})
      ORDER BY created_at DESC, end_to_end_id DESC
      LIMIT ${filter.limit ?? 500}`.execute(this.o.db);
    return Promise.all(rows.map((r) => this.pixView(r)));
  }

  private async pixView(row: PixRow) {
    const accounts = new Map(
      (
        await sql<AccountRow>`
          SELECT * FROM account WHERE id IN (${row.payer_account_id}, ${row.payee_account_id ?? row.payer_account_id})`.execute(
          this.o.db,
        )
      ).rows.map((a) => [a.id, a]),
    );
    const refunds = await sql<PixRow>`
      SELECT * FROM pix_transaction WHERE original_e2e = ${row.end_to_end_id} AND kind = 'DEVOLUCAO'`.execute(
      this.o.db,
    );
    const payee = row.payee_account_id ? accounts.get(row.payee_account_id)! : undefined;
    return {
      endToEndId: row.end_to_end_id,
      tipo: row.kind,
      status: row.status,
      ...(row.failure_code ? { motivo: row.failure_code } : {}),
      ...(row.txid ? { txid: row.txid } : {}),
      ...(row.send_id ? { idEnvio: row.send_id } : {}),
      valor: money(row.amount),
      horario: row.created_at.toISOString(),
      pagador: party(accounts.get(row.payer_account_id)!),
      recebedor: payee ? party(payee) : { nome: `(chave ${row.payee_key ?? '?'})` },
      ...(row.description ? { descricao: row.description } : {}),
      devolucoes: refunds.rows.map((r) => this.refundView(r)),
    };
  }

  // ------------------------------------------------------------------ internos

  private async nextSequence(trx: Kysely<unknown>): Promise<bigint> {
    return (await sql<{ n: bigint }>`SELECT nextval('end_to_end_seq') AS n`.execute(trx)).rows[0]!
      .n;
  }

  private async tryDebit(
    trx: Kysely<unknown>,
    accountId: string,
    amount: Decimal,
  ): Promise<boolean> {
    const res = await sql`
      UPDATE account SET balance = balance - ${amount} WHERE id = ${accountId} AND balance >= ${amount}`.execute(
      trx,
    );
    return Number(res.numAffectedRows ?? 0) === 1;
  }

  private async debit(trx: Kysely<unknown>, accountId: string, amount: Decimal): Promise<void> {
    if (!(await this.tryDebit(trx, accountId, amount))) {
      throw businessRule('SALDO_INSUFICIENTE', 'Saldo insuficiente na conta pagadora.');
    }
  }
}
