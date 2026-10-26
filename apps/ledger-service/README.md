# ledger-service

Ledger de partidas dobradas, saldos, depósito e saque por PIX simulado, extrato e reconciliação PIX
(catálogo de serviços §3, Financeiro). Rotas em `contracts/generated/openapi/ledger-service.json`.

- **Ledger** (`journal` + `ledger_entry`, append-only): todo movimento soma zero por moeda (o
  domínio valida e um gatilho diferido confere no commit), é idempotente pela `idempotency_key` e
  dá a cada conta uma sequência sem lacunas. Valor positivo = crédito ao titular (convenção em
  `src/domain/journal.ts`). Correção é estorno (`REVERSAL`) com referência ao original.
- **Plano de contas**: as contas da casa nascem na migração `0002_house_accounts`; `CUST_CASH` e
  `CUST_CASH_COLLATERAL` nascem ao consumir `account.opened`. Só as contas do RN-LED-011 mudam de
  lado; a `CUST_CASH` fica negativa só por débito do sistema.
- **Saldos** (`GET /v1/me/balances`): liquidado, projetado em D0/D1/D2 e total, holds e sacável,
  com `asOf`. Cada lançamento publica `ledger.journal_posted` e `ledger.balance_changed` (partição
  = `account_id`).
- **Depósito** (`/v1/me/deposits`): cobrança de 30 min no Banco Simulado; o webhook
  `POST /webhooks/pix-simulator` (assinado) credita `SETTLED` se o pagador é o titular (pergunta ao
  customer-service), o valor bate, a cobrança vale e a conta não está bloqueada. Senão, devolve.
- **Saque** (`/v1/me/withdrawals`, assinatura `WITHDRAWALS`): hold → (revisão acima de R$ 50 mil
  em `/v1/bo/withdrawals`) → PIX → lançamento. Limite diário e noturno; até 5 tentativas em
  30 min. Na Fase 1 os holds ficam no próprio ledger (`withdrawal_hold`, `LocalRiskHoldPort`).
- **Extrato** (`/v1/me/statement`, `/future`): filtros por período, tipo e status, cursor e saldo
  após cada lançamento.
- **Reconciliação PIX** (rotina `pix_reconciliation`, 23:15): transações do Banco Simulado contra
  `pix_transaction_ref` e a reserva PIX; divergência → alerta crítico (`ledger.critical_alert`) e
  `GET /v1/bo/reconciliations/pix/{data}`.
- **Encerramento**: `GET /v1/internal/accounts/{id}/closure-pendencies` (`closure:read`).

Laço de fundo a cada 2 s: expira cobranças, refaz devoluções pendentes, processa saques com
tentativa vencida e acerta holds de saques terminados. Tudo idempotente e retomável.

## Runbook

| Situação                                               | O que fazer                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Webhook PIX recusado (401)                             | Segredo diferente entre `webhook_pix_simulator` e o serviço, ou relógios com mais de 5 min de diferença.                                                           |
| Webhook PIX com 503                                    | O customer-service (titularidade) está fora ou sem o cliente OAuth `ledger-service` (`LEDGER_SERVICE_CLIENT_SECRET`). O simulador reenvia sozinho.                 |
| Depósito parado em `PAID`                              | A devolução está pendente: veja `pix_refund` (`status = 'PENDING'`, `last_error`). O laço tenta de novo a cada 2 s.                                                |
| Saque parado em `PROCESSING`                           | Veja `withdrawal_request` (`attempts`, `next_attempt_at`, `lease_until`). Depois de 5 tentativas em 30 min, vira `FAILED` e o hold é liberado.                     |
| Hold de saque não liberado                             | `withdrawal_request.hold_settled = false` num saque terminado: o laço repete o acerto (consumir/liberar é idempotente).                                            |
| Reconciliação `DIVERGENT`                              | `GET /v1/bo/reconciliations/pix/{data}` lista cada `endToEndId`. `REFUND_PENDING` costuma ser devolução em curso; `PIX_WITHOUT_LEDGER` de saque pede investigação. |
| `LEDGER_UNBALANCED_JOURNAL` ou `SIGN_VIOLATION` no log | Bug: o lançamento foi recusado e nada foi gravado. O cliente recebeu `500` com o `correlationId`.                                                                  |
