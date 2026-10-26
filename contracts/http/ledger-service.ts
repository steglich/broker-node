import Type from 'typebox';
import { defineHttpContract } from '../src/define.js';

const Uuid = Type.String({ format: 'uuid' });
const Date_ = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
/** Dinheiro como string decimal (API §2). */
const Money = Type.String({ pattern: '^\\d{1,16}(\\.\\d{1,2})?$' });
const Signed = Type.String({ pattern: '^-?\\d{1,16}(\\.\\d{1,2})?$' });
const IdParams = Type.Object({ id: Uuid });

export const Balances = Type.Object({
  accountId: Uuid,
  currency: Type.String(),
  settled: Signed,
  projected: Type.Object({ d0: Signed, d1: Signed, d2: Signed }),
  projectedTotal: Signed,
  holds: Money,
  withdrawable: Money,
  lastSequence: Type.Integer(),
  /** Instante da última entrada considerada (RN-LED-021). */
  asOf: Type.String({ format: 'date-time' }),
});

export const StatementLine = Type.Object({
  id: Uuid,
  sequence: Type.Integer(),
  bookingDate: Date_,
  valueDate: Date_,
  description: Type.String(),
  category: Type.String(),
  reference: Type.Object({ type: Type.String(), id: Type.String() }),
  amount: Signed,
  status: Type.Union([Type.Literal('PENDING'), Type.Literal('SETTLED')]),
  balanceAfter: Signed,
});

export const Deposit = Type.Object({
  id: Uuid,
  status: Type.Union(
    ['PENDING', 'PAID', 'CREDITED', 'REFUNDED', 'EXPIRED', 'CANCELED'].map((s) => Type.Literal(s)),
  ),
  amount: Money,
  /** Payload "copia e cola" do Banco Simulado. */
  pixCopyPaste: Type.String(),
  expiresAt: Type.String({ format: 'date-time' }),
  createdAt: Type.String({ format: 'date-time' }),
  refundReason: Type.Optional(Type.String()),
});

export const Withdrawal = Type.Object({
  id: Uuid,
  status: Type.Union(
    [
      'REQUESTED',
      'PENDING_REVIEW',
      'PROCESSING',
      'COMPLETED',
      'FAILED',
      'REJECTED',
      'CANCELED',
    ].map((s) => Type.Literal(s)),
  ),
  amount: Money,
  bankAccountId: Uuid,
  requestedAt: Type.String({ format: 'date-time' }),
  completedAt: Type.Optional(Type.String({ format: 'date-time' })),
  failureReason: Type.Optional(Type.String()),
  endToEndId: Type.Optional(Type.String()),
});

export const ledgerServiceHttp = defineHttpContract({
  service: 'ledger-service',
  title: 'ledger-service',
  version: '1.0.0',
  routes: {
    balances: {
      method: 'get',
      path: '/v1/me/balances',
      summary: 'Saldos liquidado, projetado D0/D1/D2 e total, holds e sacável, com asOf (§4).',
      auth: 'user',
      responses: { 200: { description: 'Saldos.', body: Balances } },
    },
    statement: {
      method: 'get',
      path: '/v1/me/statement',
      summary:
        'Extrato da CUST_CASH, do mais recente, com saldo após cada lançamento (RN-EXT-001/002).',
      auth: 'user',
      query: Type.Object({
        from: Type.Optional(Date_),
        to: Type.Optional(Date_),
        /** `DEPOSIT,WITHDRAWAL,TRADE,FEES,CORPORATE_ACTION,TAX,INTEREST,ADJUSTMENT`. */
        type: Type.Optional(Type.String()),
        /** `PENDING,SETTLED`. */
        status: Type.Optional(Type.String()),
        limit: Type.Optional(Type.String({ pattern: '^\\d+$' })),
        cursor: Type.Optional(Type.String()),
      }),
      responses: {
        200: {
          description: 'Página do extrato.',
          body: Type.Object({
            items: Type.Array(StatementLine),
            nextCursor: Type.Optional(Type.String()),
          }),
        },
      },
    },
    futureEntries: {
      method: 'get',
      path: '/v1/me/statement/future',
      summary: 'Lançamentos futuros (PENDING) agrupados por data-valor (RN-EXT-004).',
      auth: 'user',
      responses: {
        200: {
          description: 'Grupos por data-valor.',
          body: Type.Object({
            groups: Type.Array(
              Type.Object({ valueDate: Date_, total: Signed, items: Type.Array(StatementLine) }),
            ),
          }),
        },
      },
    },
    createDeposit: {
      method: 'post',
      path: '/v1/me/deposits',
      summary: 'Cria a cobrança PIX do depósito; expira em 30 min (RN-DEP-001/002).',
      auth: 'user',
      idempotent: true,
      body: Type.Object({ amount: Money }),
      responses: {
        201: { description: 'Cobrança criada (PENDING).', body: Deposit },
        422: {
          description: 'DEPOSIT_AMOUNT_OUT_OF_RANGE, ACCOUNT_NOT_ACTIVE, ACCOUNT_NOT_OPENED.',
        },
        503: { description: 'PIX_UNAVAILABLE.' },
      },
    },
    listDeposits: {
      method: 'get',
      path: '/v1/me/deposits',
      summary: 'Depósitos da conta, do mais recente.',
      auth: 'user',
      responses: {
        200: { description: 'Depósitos.', body: Type.Object({ items: Type.Array(Deposit) }) },
      },
    },
    getDeposit: {
      method: 'get',
      path: '/v1/me/deposits/:id',
      summary: 'Estado do depósito.',
      auth: 'user',
      params: IdParams,
      responses: {
        200: { description: 'Depósito.', body: Deposit },
        404: { description: 'Inexistente.' },
      },
    },
    cancelDeposit: {
      method: 'post',
      path: '/v1/me/deposits/:id/cancel',
      summary: 'Cancela a cobrança ainda PENDING; um pagamento depois disso é devolvido.',
      auth: 'user',
      idempotent: true,
      params: IdParams,
      responses: {
        200: { description: 'Cancelado.', body: Deposit },
        422: { description: 'DEPOSIT_NOT_CANCELABLE.' },
      },
    },
    requestWithdrawal: {
      method: 'post',
      path: '/v1/me/withdrawals',
      summary:
        'Solicita saque (assinatura WITHDRAWALS): hold no Risco, revisão acima do limite e envio PIX (§7).',
      auth: 'user',
      idempotent: true,
      body: Type.Object({ amount: Money, bankAccountId: Uuid }),
      responses: {
        202: { description: 'Aceito (PROCESSING ou PENDING_REVIEW).', body: Withdrawal },
        422: {
          description:
            'INSUFFICIENT_WITHDRAWABLE_BALANCE, WITHDRAWAL_LIMIT_EXCEEDED, BANK_ACCOUNT_NOT_ALLOWED, WITHDRAWAL_AMOUNT_TOO_LOW, ACCOUNT_NOT_ACTIVE.',
        },
        503: { description: 'CUSTOMER_UNAVAILABLE ou RISK_UNAVAILABLE.' },
      },
    },
    listWithdrawals: {
      method: 'get',
      path: '/v1/me/withdrawals',
      summary: 'Saques da conta, do mais recente.',
      auth: 'user',
      responses: {
        200: { description: 'Saques.', body: Type.Object({ items: Type.Array(Withdrawal) }) },
      },
    },
    getWithdrawal: {
      method: 'get',
      path: '/v1/me/withdrawals/:id',
      summary: 'Estado do saque.',
      auth: 'user',
      params: IdParams,
      responses: {
        200: { description: 'Saque.', body: Withdrawal },
        404: { description: 'Inexistente.' },
      },
    },
    cancelWithdrawal: {
      method: 'post',
      path: '/v1/me/withdrawals/:id/cancel',
      summary: 'Cancela o saque antes de PROCESSING; o hold é liberado (RN-SAQ-006).',
      auth: 'user',
      idempotent: true,
      params: IdParams,
      responses: {
        200: { description: 'Cancelado.', body: Withdrawal },
        422: { description: 'WITHDRAWAL_NOT_CANCELABLE.' },
      },
    },
    pixWebhook: {
      method: 'post',
      path: '/webhooks/pix-simulator',
      summary: 'Webhook `pix.recebido` do Banco Simulado, assinado (RN-DEP-005, RN-DEP-008).',
      auth: 'public',
      responses: {
        204: { description: 'Processado (ou repetido).' },
        401: { description: 'INVALID_WEBHOOK_SIGNATURE.' },
        503: { description: 'Titularidade indisponível: o simulador reenvia.' },
      },
    },
    reviewQueue: {
      method: 'get',
      path: '/v1/bo/withdrawals',
      summary: 'Saques em PENDING_REVIEW (BO_FINANCE, BO_ADMIN).',
      auth: 'user',
      responses: {
        200: { description: 'Fila.', body: Type.Object({ items: Type.Array(Withdrawal) }) },
      },
    },
    approveWithdrawal: {
      method: 'post',
      path: '/v1/bo/withdrawals/:id/approve',
      summary: 'Aprova o saque em revisão: segue para o envio (RN-SAQ-005).',
      auth: 'user',
      params: IdParams,
      responses: { 200: { description: 'PROCESSING.', body: Withdrawal } },
    },
    rejectWithdrawal: {
      method: 'post',
      path: '/v1/bo/withdrawals/:id/reject',
      summary: 'Reprova o saque em revisão; o hold é liberado.',
      auth: 'user',
      params: IdParams,
      body: Type.Object({ reason: Type.String({ minLength: 3, maxLength: 500 }) }),
      responses: { 200: { description: 'REJECTED.', body: Withdrawal } },
    },
    reconciliation: {
      method: 'get',
      path: '/v1/bo/reconciliations/pix/:date',
      summary: 'Resultado da reconciliação PIX da data (RN-PIXS-002).',
      auth: 'user',
      params: Type.Object({ date: Date_ }),
      responses: { 200: { description: 'Reconciliação.' }, 404: { description: 'Não executada.' } },
    },
    closurePendencies: {
      method: 'get',
      path: '/v1/internal/accounts/:id/closure-pendencies',
      summary:
        'Pendências do ledger para o encerramento da conta (RN-ACC-012), escopo closure:read.',
      auth: 'service',
      params: IdParams,
      responses: {
        200: {
          description: 'Pendências (vazio = pode encerrar).',
          body: Type.Object({
            pendencies: Type.Array(Type.Object({ code: Type.String(), message: Type.String() })),
          }),
        },
      },
    },
  },
});

export default ledgerServiceHttp;
