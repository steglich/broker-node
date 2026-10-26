# Fase 1, grupo 15 — ledger-service

> Tarefas 15.1 a 15.6 de `openspec/changes/implementation-roadmap/tasks.md`. Spec: `specs/ledger-funds/spec.md`. Regras: `broker-docs/docs/01-dominio/03-financeiro.md` (RN-LED, RN-DEP, RN-SAQ, RN-EXT), Sistemas simulados §2 (RN-PIXS-002), modelo de dados §3, catálogo de eventos §3. Design: D4 (append-only), D5 (decimal), D11 (RPC), RN-PAD-030 (saga).

## Visão geral

O ledger é o único lugar onde o dinheiro muda de lugar. Tudo vira um **journal** de partidas dobradas:

```
depósito  ─▶ D HOUSE_PIX_RESERVE / C CUST_CASH   (SETTLED)
saque     ─▶ D CUST_CASH / C HOUSE_PIX_RESERVE   (SETTLED, depois do PIX confirmado)
negócio   ─▶ D CUST_CASH / C CLEARING_HOUSE      (PENDING, valor em D+2)   ← fases seguintes
```

Em volta do núcleo ficam os saldos (liquidado, projetado, sacável), os fluxos de depósito e saque com o Banco Simulado, o extrato e a reconciliação PIX diária.

## Decisões tomadas no apply

- **Convenção de sinal num lugar só** (`src/domain/journal.ts`): `amount > 0` é crédito ao titular. A função `signed(side, valor)` é a única que transforma lado em sinal. Assim, o saldo de qualquer conta é a soma das entradas, e o journal soma zero.
- **Natureza das contas**: cada conta tem `normal_side` (credora ou devedora) e `any_sign`. As do RN-LED-011 aceitam qualquer sinal; as outras não passam para o lado contrário. A `CUST_CASH` é a exceção controlada: um débito do sistema (`systemDebit`) pode deixá-la negativa (RN-DEV-001), um comando do cliente não.
- **Titularidade sem CPF no ledger**: o webhook traz o CPF do pagador; o ledger pergunta ao customer-service se ele é o do titular (`holder-match`, comparação por HMAC) e guarda só o HMAC dele, com chave própria.
- **Holds na Fase 1**: a porta `RiskHoldPort` tem um adaptador provisório (`LocalRiskHoldPort`) que calcula o sacável no próprio ledger e grava em `withdrawal_hold`. Na Fase 2 o adaptador vira o RPC `risk.CreateHold/ReleaseHold`, sem mudar a saga.
- **Saga de saque sem o `SagaOrchestrator`**: o orquestrador do service-kit repete passos na hora; o RN-SAQ-007 pede backoff de minutos. O estado fica na própria linha (`attempts`, `next_attempt_at`, `lease_until`, `hold_settled`) e um laço processa o que venceu.
- **Rotina própria para a reconciliação PIX** (`pix_reconciliation`, 23:15): a `reconciliations` depende de rotinas da Fase 3.

## 15.1 — Journal, soma zero, idempotência e sequência

Duas barreiras para o INV-01:

1. `buildJournal` (domínio) recusa menos de duas linhas, valor zero ou negativo, mais de 2 casas e soma ≠ 0 (`LEDGER_UNBALANCED_JOURNAL`).
2. No banco, um `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` em `journal` e `ledger_entry` confere, **no commit**, que cada journal tem ≥ 2 entradas e soma zero por moeda. Diferido porque, no meio da transação, as entradas ainda estão sendo inseridas uma a uma.

Uma pegadinha: a mesma função de gatilho serve às duas tabelas, mas o PL/pgSQL compila `NEW.journal_id` mesmo num ramo `CASE` que não roda, e a linha de `journal` não tem essa coluna. A coluna vem por argumento (`TG_ARGV[0]`) e é lida com `to_jsonb(NEW) ->> ...`.

**Imutabilidade**: `journal` usa o `makeAppendOnly` da plataforma. `ledger_entry` tem uma regra própria, porque `status` muda uma vez (`PENDING → SETTLED`, RN-LED-006): o usuário da aplicação tem `UPDATE` só nas colunas `status`, `settlement_batch_id` e `settled_at`, e o gatilho `ledger_entry_guard` recusa qualquer outra mudança, até para o dono da tabela.

**Idempotência** (RN-LED-003): `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`. Se não inseriu, devolve o journal existente. Numa corrida, o segundo espera o índice único do primeiro e cai no existente.

**Sequência por conta** (RN-LED-007): as contas do journal são travadas com `FOR UPDATE` **ordenadas por id** (sem deadlock entre journals que tocam as mesmas contas), e `last_sequence` avança pela quantidade de entradas. O teste dispara três lançamentos em paralelo e confere `1, 2, 3`.

**Estorno** (RN-LED-002): `reversalOf` inverte cada linha, com chave `reversal:{journal_id}` (um journal se estorna uma vez) e `reverses_journal_id` único.

Os testes de propriedade (fast-check) geram journals balanceados aleatórios: todo aceito soma zero; somar um centavo qualquer é recusado; journal + estorno zera cada conta. No banco, depois de journals aleatórios, nenhum journal e nem o ledger inteiro têm soma ≠ 0.

## 15.2 — Plano de contas

As 15 contas da casa entram na migração `0002_house_accounts` (RN-LED-010). O índice `UNIQUE NULLS NOT DISTINCT (code, owner_id)` (PostgreSQL 15+) faz `NULL` contar como valor: não existem duas `HOUSE_PIX_RESERVE`. As do cliente nascem no consumidor de `account.opened` com `ON CONFLICT DO NOTHING`; o evento repetido não cria outra. O consumidor do tópico `customer` é ordenado: o `account.status_changed` de uma conta não passa na frente da abertura.

## 15.3 — Saldos e eventos

```
projected(Dn) = liquidado + pendentes com value_date ≤ Dn
withdrawable  = max(0, min(liquidado, P(D0), P(D1), P(D2)) − holds)
```

D0 é o dia útil corrente pelo calendário (num sábado, a segunda). O banco devolve as somas por `status` e `value_date`; o domínio (`computeBalances`) faz o resto. `asOf` é o `posted_at` da última entrada (RN-LED-021).

Cada journal publica `ledger.journal_posted` (com as sequências) e, para cada `CUST_CASH` tocada, `ledger.balance_changed` com `lastSequence`: o Risco descarta um saldo mais velho que o que já tem. Partição = `account_id`.

O cenário **LED-001** está em `scenarios/led/LED-001.yaml` (golden master, independente de tecnologia). O adaptador `LED` chama o domínio do ledger, exposto pelo `exports` `./domain/*` do pacote. O mesmo cenário roda pela API em `test/balances.test.ts`.

## 15.4 — Depósito

```
POST /v1/me/deposits ─▶ PUT /cob/{txid} (30 min) ─▶ PENDING
Banco Simulado ─ webhook pix.recebido (HMAC) ─▶ holder-match? ─▶ decidePayment
   CREDIT ─▶ journal SETTLED + CREDITED + deposit.credited
   REFUND ─▶ pix_refund PENDING ─▶ PUT /pix/{e2e}/devolucao/{id} ─▶ REFUNDED + deposit.refunded
```

- **Idempotência pelo `end_to_end_id`** (RN-DEP-005): `pix_transaction_ref` (append-only) registra todo PIX visto. A cobrança é travada antes da checagem, então duas entregas simultâneas do mesmo pagamento se enfileiram. O crédito também tem a chave `deposit:{id}`: mesmo que algo escapasse, o journal não duplica.
- **Devolução retomável**: o webhook grava a devolução como `PENDING` na mesma transação da decisão e tenta na hora; se o banco falhar, o laço de fundo repete (idempotente pelo id da devolução).
- **Titularidade fora do ar**: o webhook responde `503` e o simulador reenvia (RN-SIM-004).
- **Vencida**: horário do pagamento a partir do vencimento, ou cobrança já vencida pela rotina de expiração (o caso do webhook atrasado do RN-PIXS-003). A cobrança fica `EXPIRED` e o valor volta.

## 15.5 — Saque

```
pedido (assinatura WITHDRAWALS) ─▶ elegibilidade + destino (customer-service) ─▶ limites
  ─▶ REQUESTED ─▶ CreateHold ─┬─ recusado ─▶ REJECTED, 422 INSUFFICIENT_WITHDRAWABLE_BALANCE
                              ├─ > R$ 50 mil ─▶ PENDING_REVIEW ─▶ aprovação/reprovação no backoffice
                              └─▶ PROCESSING ─▶ envio PIX (idEnvio = id do saque)
                                    ├─ ok ─▶ journal + COMPLETED ─▶ consome o hold
                                    ├─ recusa ─▶ FAILED ─▶ libera o hold
                                    └─ transitório ─▶ nova tentativa em 1, 2, 4, 8 min (5 em 30 min)
```

- **Limites** (RN-SAQ-004): a noite (20h–6h) é calculada no fuso de São Paulo; o diário soma os saques do dia que não falharam. A checagem e a gravação acontecem com a linha da conta travada: dois pedidos simultâneos não furam o limite.
- **Hold aberto desde o pedido**: `hold_settled = false` já na criação. Se o pedido do hold cair no meio, a liberação (idempotente, e sem efeito num hold que não existe) desfaz o que tiver ficado. O acerto do hold roda fora da transação do saque, porque o hold é de outro contexto, e o laço repete até dar certo.
- **Envio idempotente**: uma tentativa que deu timeout mas executou é reconhecida na seguinte pelo mesmo `idEnvio`. Se todas derem timeout e o PIX tiver saído, a reconciliação aponta `PIX_WITHOUT_LEDGER`.

## 15.6 — Extrato e reconciliação

O extrato é a `CUST_CASH` do mais recente ao mais antigo. O **saldo após** é `sum(amount) OVER (ORDER BY sequence)` calculado sobre a conta inteira **antes** dos filtros: filtrar por tipo não muda o saldo após de cada linha. O cursor é a sequência. Para contas com muito histórico, o `balance_snapshot` do modelo de dados entra na Fase 7 (a janela hoje percorre a conta toda).

A reconciliação compara, numa janela contínua (começa onde a anterior parou e termina 5 min antes de agora, para não pegar um PIX ainda sendo lançado):

| No Banco Simulado                       | Esperado no ledger                                 | Divergência                                                     |
| --------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| pagamento de cobrança concluído         | `pix_transaction_ref` com journal ou com devolução | `PIX_WITHOUT_LEDGER`, `CREDITED_AND_REFUNDED`, `REFUND_PENDING` |
| envio concluído                         | ref com journal                                    | `PIX_WITHOUT_LEDGER`                                            |
| envio não realizado                     | nenhum journal                                     | `LEDGER_WITHOUT_PIX`                                            |
| devolução                               | ref `REFUND`                                       | `PIX_WITHOUT_LEDGER`                                            |
| (lado do ledger) entrada na reserva PIX | PIX concluído com o mesmo valor                    | `LEDGER_WITHOUT_PIX`, `AMOUNT_MISMATCH`                         |

Divergência → log `ledger.critical_alert` com severidade `critical` e o resultado em `GET /v1/bo/reconciliations/pix/{data}`.

## O que ficou para depois

- Liquidação D+2, fechamento da câmara, saldo devedor (eventos e juros), outras cobranças e ajustes: estão na spec, mas não nas tarefas do grupo 15 (entram com o clearing e o approval-service).
- A listagem `GET /pix` do simulador devolve no máximo 500 transações por chamada; um dia com mais que isso precisa de paginação na API do simulador.
