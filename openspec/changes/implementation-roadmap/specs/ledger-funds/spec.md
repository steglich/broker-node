# Spec Delta

## Purpose

Registra todo movimento de dinheiro num ledger de partidas dobradas, imutável e auditável, fornece os saldos do cliente e opera depósitos e saques via PIX simulado, liquidação financeira D+2, saldo devedor, ajustes e extrato.

## ADDED Requirements

### Requirement: Partidas dobradas
Todo movimento SHALL ser um `journal` com duas ou mais `ledger_entry` cuja soma seja zero por moeda; um journal desbalanceado SHALL ser recusado com `LEDGER_UNBALANCED_JOURNAL` (RN-LED-001, INV-01).

#### Scenario: Journal desbalanceado
- **WHEN** um caso de uso tenta gravar um journal com débito de 100,00 e crédito de 99,99
- **THEN** a gravação é recusada e nada é persistido

### Requirement: Imutabilidade e estorno
Lançamentos SHALL NOT ser alterados nem apagados; uma correção SHALL ser um estorno que referencia o original, seguido de novo lançamento. O usuário da aplicação no banco SHALL NOT ter permissão de `UPDATE`/`DELETE` nas entradas (RN-LED-002, RN-DB modelagem: imutáveis).

#### Scenario: Correção de lançamento
- **WHEN** um lançamento precisa ser corrigido
- **THEN** o ledger grava o estorno com referência ao original e um novo lançamento, e o original fica intacto

### Requirement: Idempotência do journal
Todo journal SHALL ter `idempotency_key` única (ex.: `trade:{trade_id}:buyer`); repetir o comando SHALL devolver o lançamento existente (RN-LED-003).

#### Scenario: Alocação reprocessada
- **WHEN** `clearing.trade_allocated` do mesmo negócio é processado duas vezes
- **THEN** existe um único journal `trade:{trade_id}:buyer`

### Requirement: Datas e status das entradas
Cada entrada SHALL ter `booking_date`, `value_date` e status `PENDING` ou `SETTLED`; a passagem a `SETTLED` SHALL ocorrer só pela rotina de liquidação ou por movimento que liquida na hora. Cada conta do ledger SHALL ter sequência crescente sem lacunas (RN-LED-005..007).

#### Scenario: Sequência por conta
- **WHEN** três lançamentos são gravados na mesma conta
- **THEN** as sequências são consecutivas, sem lacunas

### Requirement: Plano de contas
O ledger SHALL manter, por cliente, `CUST_CASH` e `CUST_CASH_COLLATERAL`, criadas ao consumir `account.opened`, e as contas da casa (`HOUSE_PIX_RESERVE`, `CLEARING_HOUSE`, `SMM_CASH`, `REV_*`, `PAY_*`, `ISSUER_DISTRIBUTIONS`, `HOUSE_ADJUSTMENTS`, `BTC_POOL`) criadas só por migração/configuração. Só contas da casa autorizadas podem ter saldo de qualquer sinal (RN-LED-010, RN-LED-011).

#### Scenario: Conta aberta
- **WHEN** o ledger consome `account.opened`
- **THEN** as contas `CUST_CASH` e `CUST_CASH_COLLATERAL` do cliente passam a existir, uma única vez

### Requirement: Cálculo de saldos
O ledger SHALL calcular `settled_balance`, `projected_balance(Dn)`, `projected_balance_total` e `withdrawable_balance = max(0, min(settled, P(D0), P(D1), P(D2)) − holds que afetam saque)`, e todo saldo exposto SHALL trazer `as_of` (Financeiro §4, RN-LED-020, RN-LED-021).

#### Scenario: Saldo sacável (LED-001)
- **WHEN** o cliente tem R$ 10.000,00 liquidados e, em D0, compra R$ 6.000,00 e vende R$ 3.000,00 com liquidação em D2
- **THEN** `projected_balance(D2)` é R$ 7.000,00 e `withdrawable_balance` é R$ 7.000,00

### Requirement: Eventos de saldo
O ledger SHALL publicar `ledger.journal_posted` com as entradas e `ledger.balance_changed` com os saldos recalculados, particionados por `account_id` (RN-LED-031, Financeiro §13).

#### Scenario: Projeção do Risco
- **WHEN** um depósito é creditado
- **THEN** `ledger.balance_changed` é publicado e o Risco atualiza o saldo projetado da conta

### Requirement: Intenção de depósito
O depósito SHALL criar uma cobrança no simulador PIX com valor entre R$ 1,00 e R$ 1.000.000,00 (parametrizáveis) e expiração padrão de 30 min, seguindo os estados `PENDING`, `PAID`, `CREDITED`, `REFUNDED`, `EXPIRED` e `CANCELED` (RN-DEP-001, RN-DEP-002, Financeiro §6.3).

#### Scenario: Valor fora da faixa
- **WHEN** o cliente pede depósito de R$ 0,50
- **THEN** a resposta é `422` com `DEPOSIT_AMOUNT_OUT_OF_RANGE`

### Requirement: Crédito do depósito
O crédito SHALL ocorrer só quando o CPF do pagador é igual ao do cliente, o valor é igual ao da cobrança, a cobrança não expirou e a conta não está `BLOCKED`/`CLOSED`; senão o valor SHALL ser devolvido integralmente. O crédito é `SETTLED` imediato, 24/7, idempotente pelo `end_to_end_id` (RN-DEP-003..007).

#### Scenario: Depósito de terceiro
- **WHEN** o webhook informa pagador com CPF diferente do cliente
- **THEN** o ledger pede a devolução e publica `deposit.refunded`, sem crédito

#### Scenario: Depósito válido
- **WHEN** o webhook confirma pagamento do próprio cliente com o valor da cobrança
- **THEN** o ledger lança D `HOUSE_PIX_RESERVE` / C `CUST_CASH` `SETTLED` e publica `deposit.credited`

#### Scenario: Pagamento após expiração
- **WHEN** o pagamento chega depois da expiração da cobrança
- **THEN** o valor é devolvido e a cobrança fica `EXPIRED`

### Requirement: Saga de saque
O saque SHALL ser orquestrado pelo ledger: criar hold `WITHDRAWAL` no Risco (síncrono), enviar o PIX, lançar D `CUST_CASH` / C `HOUSE_PIX_RESERVE` `SETTLED` e consumir o hold; em falha, SHALL liberar o hold. O estado SHALL ser persistido e retomável (RN-LED-032, RN-PAD §5).

#### Scenario: Saque concluído
- **WHEN** o hold é criado e o PIX é confirmado
- **THEN** o lançamento é feito, o hold é consumido e `withdrawal.completed` é publicado

#### Scenario: Saldo insuficiente
- **WHEN** o Risco recusa o hold
- **THEN** o saque é recusado com `INSUFFICIENT_WITHDRAWABLE_BALANCE` e nada é enviado ao PIX

### Requirement: Regras do saque
O saque SHALL exigir assinatura eletrônica, valor mínimo R$ 1,00, destino cadastrado de mesma titularidade fora da carência, limite diário (padrão R$ 100.000,00) e limite noturno de 20h às 6h (padrão R$ 1.000,00 por transação), todos parametrizáveis (RN-SAQ-001..004).

#### Scenario: Limite noturno
- **WHEN** o cliente pede saque de R$ 1.500,00 às 22h
- **THEN** a resposta é `422` com `WITHDRAWAL_LIMIT_EXCEEDED`

#### Scenario: Conta em carência
- **WHEN** o destino foi cadastrado há 2 horas
- **THEN** a resposta é `422` com `BANK_ACCOUNT_NOT_ALLOWED`

### Requirement: Revisão e estados do saque
Saques acima de R$ 50.000,00 (parametrizável) SHALL ir para `PENDING_REVIEW` com hold já criado; os estados são `REQUESTED`, `PENDING_REVIEW`, `PROCESSING`, `COMPLETED`, `FAILED`, `REJECTED` e `CANCELED` (só antes de `PROCESSING`). Falhas transitórias SHALL ter até 5 tentativas em 30 min antes de `FAILED` (RN-SAQ-005..008).

#### Scenario: Falha definitiva
- **WHEN** o simulador falha nas 5 tentativas
- **THEN** o saque fica `FAILED`, o hold é liberado e `withdrawal.failed` é publicado

### Requirement: Liquidação financeira D+2
Cada negócio SHALL gerar, em D0, lançamentos `PENDING` com `value_date` = D0 + 2 dias úteis; a rotina diária (padrão 08:00) SHALL liquidar os `PENDING` com `value_date` ≤ hoje num lote com `settlement_batch_id`, de forma líquida por cliente e data, mantendo os lançamentos individuais (RN-LIQ-001..003, RN-LIQ-005).

#### Scenario: D+2 com feriado (LED-010)
- **WHEN** um negócio ocorre numa quinta-feira e a sexta-feira é feriado
- **THEN** o `value_date` é a terça-feira seguinte

### Requirement: Fechamento da câmara
Após cada lote, `CLEARING_HOUSE` SHALL fechar com saldo líquido zero para aquele `value_date`; uma diferença SHALL disparar alerta crítico e travar o próximo lote até intervenção (RN-LIQ-004).

#### Scenario: Diferença na câmara
- **WHEN** o lote termina com `CLEARING_HOUSE` diferente de zero
- **THEN** é emitido alerta crítico e o lote seguinte não é executado

### Requirement: Saldo devedor
Saldo devedor SHALL ser permitido só para débitos do sistema; com `settled_balance < 0` o ledger SHALL publicar `ledger.negative_balance_detected`, cobrar juros diários pro rata (padrão 8% a.m.) após o fechamento e publicar `ledger.negative_balance_cleared` ao voltar a ≥ 0 (RN-DEV-001..005, INV-05).

#### Scenario: Custos maiores que o saldo
- **WHEN** a liquidação deixa o `settled_balance` em −R$ 10,00
- **THEN** `ledger.negative_balance_detected` é publicado e os juros passam a ser lançados diariamente

### Requirement: Outras cobranças
O ledger SHALL lançar a taxa de custódia no 1º dia útil do mês (padrão R$ 0,00), proventos, taxas de BTC e pagamento de DARF a partir dos eventos dos respectivos donos (Financeiro §10).

#### Scenario: Provento pago
- **WHEN** chega `corporate_action.paid` com líquido e IR
- **THEN** o ledger lança D `ISSUER_DISTRIBUTIONS` / C `CUST_CASH` e C `PAY_IRRF`, `SETTLED`

### Requirement: Ajustes manuais
Ajustes SHALL ser criados só pelo backoffice, entre `CUST_CASH` e `HOUSE_ADJUSTMENTS`, com motivo obrigatório, e executados só após `approval.request_approved` (maker diferente do checker; acima de R$ 10.000,00, checker `BO_ADMIN`) (RN-AJU-001..003).

#### Scenario: Ajuste aprovado
- **WHEN** o ledger consome a aprovação de um ajuste
- **THEN** lança o ajuste uma única vez, idempotente pelo `approval_request_id`

### Requirement: Extrato
O extrato SHALL listar cada entrada de `CUST_CASH` com data de lançamento, data-valor, descrição, referência, valor com sinal, status e saldo após o lançamento, com filtros por período, tipo e status, e uma seção de lançamentos futuros agrupados por data-valor (RN-EXT-001, RN-EXT-002, RN-EXT-004).

#### Scenario: Lançamentos futuros
- **WHEN** o cliente consulta o extrato com compras a liquidar
- **THEN** os lançamentos `PENDING` aparecem agrupados por data-valor na seção de futuros

### Requirement: Reconciliação PIX
O ledger SHALL comparar diariamente as transações do simulador PIX com os lançamentos de `HOUSE_PIX_RESERVE` e alertar em caso de divergência (RN-PIXS-002).

#### Scenario: Transação sem lançamento
- **WHEN** existe um PIX confirmado no simulador sem lançamento correspondente
- **THEN** a reconciliação gera alerta
