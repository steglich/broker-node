# Spec Delta

## Purpose

Processa o pós-negociação: aloca cada negócio às contas, classifica day trade e swing, calcula custos pela tabela vigente, gera a nota de corretagem e orquestra a liquidação D+2 de ativos e dinheiro, incluindo a recompra compulsória por falha de entrega.

## ADDED Requirements

### Requirement: Alocação de negócios
Cada `engine.trade_executed` SHALL gerar duas alocações (compradora e vendedora) com notional, `trading_date` e `settlement_date = D+2`, de forma idempotente por `(trade_id, side)`, e publicar `clearing.trade_allocated` particionado por `account_id` (RN-CLR-001..003, RN-PAD-050).

#### Scenario: Negócio reentregue
- **WHEN** o mesmo `engine.trade_executed` é processado duas vezes
- **THEN** existem exatamente duas alocações para aquele `trade_id`

### Requirement: Alocação do FMS
Alocações do FMS SHALL seguir o mesmo fluxo, sem custos, nota ou IR (RN-CLR-004, RN-FEE-032).

#### Scenario: Ponta do FMS
- **WHEN** o FMS vende para um cliente
- **THEN** a alocação do FMS não entra em nenhuma nota de corretagem

### Requirement: Classificação day trade e swing
No fechamento (e de forma provisória em tempo real), o Clearing SHALL classificar por conta, instrumento (principal + fracionário) e dia: `Q_dt = min(C, V)` aos preços médios do dia de compra e de venda, e o restante como swing; o resultado de day trade é `Q_dt × (venda_média − compra_média) − custos_dt` e SHALL publicar `clearing.daytrade_classified` (RN-CLR-010, RN-CLR-013, Custódia §2.2).

#### Scenario: Classificação do exemplo (CLR-001)
- **WHEN** a conta tem 300 PETR4 a PM 30,00, compra 200 a 38,00 e vende 500 a 38,50 no dia
- **THEN** o day trade é 200 com resultado bruto R$ 100,00 e o swing é a venda de 300 com resultado bruto R$ 2.550,00

### Requirement: Tabela de custos com vigência
Os custos SHALL usar a `fee_schedule` vigente na data do pregão (corretagem `ZERO`, `FLAT_PER_ORDER` ou `PERCENT_TABLE`, ISS, emolumentos, liquidação com faixas de day trade pelo volume do mês, IRRF swing e day trade, taxa de zeragem), com mudanças por dupla aprovação e vigência nunca no passado, publicando `fees.schedule_changed` (RN-FEE-001..003, RN-FEE-010..012, RN-FEE-020).

#### Scenario: Vigência no passado
- **WHEN** o backoffice propõe uma tabela com início ontem
- **THEN** a proposta é recusada

#### Scenario: Corretagem por ordem em dias diferentes
- **WHEN** uma ordem GTC com `FLAT_PER_ORDER` executa em dois pregões
- **THEN** a corretagem é cobrada em cada um dos dois dias

### Requirement: Cálculo e arredondamento na nota
O cálculo SHALL ser por nota e modalidade: emolumentos e liquidação sobre o volume, corretagem e ISS, IRRF swing de 0,005% sobre vendas swing (zero se ≤ R$ 1,00) e IRRF day trade de 1% sobre o resultado positivo, cada componente com 8 casas e `HALF_UP` a centavos por componente e modalidade, nunca por negócio (Custos §4, RN-FEE-030).

#### Scenario: Custos do exemplo (FEE-001)
- **WHEN** a nota tem só a compra de 100 PETR4 a R$ 38,50 com corretagem zero
- **THEN** os custos são emolumentos R$ 0,19 e liquidação R$ 0,96, total R$ 1,15, e o líquido D+2 é −R$ 3.851,15

### Requirement: Rateio dos custos
Os custos SHALL ser rateados entre day trade e swing, e entre compras e vendas, pelo volume financeiro; por negócio, proporcionalmente ao notional, com o resíduo para o maior notional e desempate pelo `trade_id` (RN-CLR-012, RN-FEE-031).

#### Scenario: Resíduo de centavos (FEE-010)
- **WHEN** R$ 0,05 de custos é rateado entre três negócios de notional igual
- **THEN** a soma rateada é exatamente R$ 0,05 e o resíduo vai para o de menor `trade_id`

### Requirement: Nota de corretagem
O Clearing SHALL gerar, na rotina pós-fechamento, uma nota por conta e pregão com negócios, com número sequencial por conta e `note_id`, conteúdo inspirado no padrão SINACOR (cabeçalho, negócios com marca `D` de day trade, resumos, custos, líquido para D+2) e marca "SIMULADO — SEM VALOR LEGAL", publicando `clearing.note_generated` com todos os valores (RN-NTC-001..004).

#### Scenario: Conta sem negócios
- **WHEN** uma conta não negociou no pregão
- **THEN** nenhuma nota é gerada para ela

#### Scenario: Efeitos da nota
- **WHEN** `clearing.note_generated` é publicado
- **THEN** o ledger lança os custos como `PENDING` para D+2, a custódia recalcula o PM com custos efetivos e a tributação registra as bases

### Requirement: Correções após a nota
Trade bust após a nota SHALL ser proibido; correções SHALL ocorrer só por ajuste do backoffice com nota de retificação (`note_type = CORRECTION`) (RN-NTC-005, RN-BST-001).

#### Scenario: Retificação
- **WHEN** o backoffice aprova uma correção de nota já gerada
- **THEN** é gerada uma nota `CORRECTION` e a original permanece

### Requirement: Reversão por trade bust
Ao consumir `engine.trade_busted` antes das notas, o Clearing SHALL reverter as alocações do negócio (RN-BST-002).

#### Scenario: Bust no mesmo pregão
- **WHEN** um negócio é cancelado antes da geração das notas
- **THEN** suas alocações são revertidas e ele não aparece na nota

### Requirement: Liquidação D+2 entrega contra pagamento
O Clearing SHALL orquestrar a liquidação: instruções, custódia liquida ativos, ledger liquida dinheiro, concluído; os lotes de ativos e de dinheiro do mesmo `settlement_date` SHALL concluir juntos ou ser revertidos juntos, com alerta ao backoffice, publicando `clearing.settlement_completed` ou `clearing.settlement_failed` (RN-LQA-001, RN-LQA-002, RN-PAD §5).

#### Scenario: Falha no lote financeiro
- **WHEN** a liquidação de ativos conclui e a financeira falha
- **THEN** a liquidação de ativos é revertida e `clearing.settlement_failed` é publicado

### Requirement: Recompra compulsória
Falha de entrega em D+2 SHALL gerar `clearing.buy_in_required` e recompra compulsória contra o vendedor no pregão de D+2, com multa parametrizável (padrão 0,5%) e o comprador recebendo na liquidação seguinte (RN-LQA-003).

#### Scenario: Vendedor sem ativo
- **WHEN** em D+2 o vendedor não tem o ativo para entregar
- **THEN** a recompra compulsória é disparada e a multa é cobrada

### Requirement: Estimativa de custos
O Clearing SHALL oferecer a estimativa de custos usada pela boleta e pelo Risco, pela tabela vigente (RN-FEE-040, RN-FEE-042, RN-HLD-003).

#### Scenario: Estimativa para o Risco
- **WHEN** o Risco pede a estimativa de uma compra
- **THEN** recebe corretagem, emolumentos, liquidação e ISS pela tabela vigente
