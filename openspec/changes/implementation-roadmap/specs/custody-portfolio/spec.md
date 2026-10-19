# Spec Delta

## Purpose

Mantém as posições de ativos de cada conta com movimentos imutáveis em partidas dobradas, calcula preço médio e resultado pela regra fiscal e oferece a visão de carteira, patrimônio, rentabilidade e extrato de custódia.

## ADDED Requirements

### Requirement: Posição por conta e instrumento
A custódia SHALL manter uma posição por `(account_id, instrument_id)` com quantidade liquidada, a receber, a entregar, projetada (`settled + pending_in − pending_out`), doada, tomada, PM, preço médio de short, custo total e resultado realizado acumulado (Custódia §3.1).

#### Scenario: Compra não liquidada
- **WHEN** uma compra de 100 é alocada em D0
- **THEN** `pending_in_quantity` é 100 e `projected_quantity` aumenta 100 até a liquidação

### Requirement: Movimentos imutáveis em partidas dobradas
A posição SHALL mudar só por eventos (alocação, liquidação, evento corporativo, aluguel, transferência, ajuste aprovado), cada um gerando `custody_movement` imutável em partidas dobradas por instrumento com as contas do sistema (`CLEARING_HOUSE_SECURITIES`, `SMM_SECURITIES`, `ISSUER_SECURITIES`, `BTC_HOUSE_LENDER`) (RN-CST-001..003, INV-02).

#### Scenario: Conservação de ativos
- **WHEN** qualquer sequência de negócios, liquidações e eventos é aplicada
- **THEN** a soma das posições de clientes, FMS, tesouraria e BTC de cada instrumento é igual ao estoque emitido

### Requirement: Preço médio na compra
Na compra de posição comprada ou zerada, o PM SHALL ser `(qtd × PM + qtd_comprada × preço + custos) / (qtd + qtd_comprada)`, guardado com 8 casas (RN-PM-001, RN-PM-008).

#### Scenario: PM com custos (FEE-001)
- **WHEN** a posição zerada recebe a compra de 100 a 38,50 com custos de R$ 1,15
- **THEN** o PM é R$ 38,5115

### Requirement: Venda e zeragem
A venda SHALL NOT alterar o PM e SHALL realizar `qtd × (preço_venda − PM) − custos`; com a quantidade zerada, o PM SHALL voltar a zero (RN-PM-002, RN-PM-003).

#### Scenario: Venda com lucro (PM-001..010)
- **WHEN** a conta vende 100 a 40,00 com PM 38,00 e custos de R$ 1,00
- **THEN** o resultado realizado é R$ 199,00 e o PM continua 38,00

### Requirement: Venda a descoberto e inversão
Abrir ou aumentar posição vendida SHALL calcular `short_average_price` por média ponderada líquida de custos, e a recompra SHALL realizar `qtd × (short_average_price − preço_compra) − custos`; uma operação maior que a posição oposta SHALL ser dividida em zeragem e abertura (RN-PM-004, RN-PM-005).

#### Scenario: Inversão de posição
- **WHEN** a conta comprada em 100 vende 150
- **THEN** 100 realizam resultado contra o PM e 50 abrem posição vendida com novo `short_average_price`

### Requirement: Day trade fora do PM
Operações classificadas como day trade SHALL NOT alterar o PM da posição swing (RN-PM-007, RN-CLR-011).

#### Scenario: Compra e venda no mesmo dia
- **WHEN** a conta com 300 a PM 30,00 compra 200 e vende 500 no dia
- **THEN** o PM da posição swing usado na venda de 300 continua 30,00

### Requirement: PM provisório e recálculo
Antes da nota, o PM SHALL usar custos estimados e ficar `provisional = true`; ao consumir `clearing.note_generated`, SHALL ser recalculado com os custos efetivos rateados e publicar `custody.average_cost_recalculated` (RN-PM-006).

#### Scenario: Nota gerada
- **WHEN** a nota do dia é gerada
- **THEN** o PM da posição deixa de ser provisório e reflete os custos efetivos

### Requirement: Liquidação de ativos
Na liquidação D+2 orquestrada pelo Clearing, a custódia SHALL passar as quantidades pendentes a liquidadas de forma atômica por lote e SHALL reverter o lote quando o Clearing pedir compensação (RN-LQA-001, RN-LQA-002).

#### Scenario: Compensação
- **WHEN** o Clearing pede a reversão de um lote já aplicado
- **THEN** as quantidades voltam a pendentes por movimentos de estorno

### Requirement: Transferência de custódia
O cliente SHALL poder pedir entrada de custódia (instrumento, quantidade, PM e data) com assinatura e aprovação do backoffice (automática no sandbox), gerando movimento `ISSUER_SECURITIES → cliente` com `source = CUSTODY_TRANSFER_IN`; a saída SHALL remover a posição sem realizar resultado (RN-TRF-001..003).

#### Scenario: Entrada no sandbox
- **WHEN** o cliente do sandbox pede entrada de 200 ITUB4 a PM 30,00
- **THEN** a posição é criada com PM 30,00 sem aprovação manual

### Requirement: Carteira e patrimônio
A carteira SHALL mostrar por posição preço atual (precedência RN-MD-002), valor de mercado, resultado não realizado em valor e percentual, variação do dia e participação, e o patrimônio SHALL somar saldo projetado total, compradas, menos vendidas, mais proventos provisionados (Custódia §4.1, §4.2).

#### Scenario: Patrimônio com provento provisionado
- **WHEN** a conta tem um dividendo com data-ex passada e ainda não pago
- **THEN** o valor provisionado entra no patrimônio

### Requirement: Rentabilidade TWR
A rentabilidade SHALL usar TWR a partir de snapshots diários com patrimônio de fechamento e fluxos externos (depósitos, saques, transferências), com proventos tratados como rendimento, para dia, mês, ano, 12 meses e desde o início, com benchmark Ibovespa externo, além de rentabilidade e distribuição por ativo, tipo e setor (RN-RNT-001..004).

#### Scenario: Depósito não é rendimento
- **WHEN** a conta recebe um depósito de R$ 10.000,00 num dia sem variação de preços
- **THEN** a rentabilidade do dia é zero

### Requirement: Extrato de custódia
O extrato SHALL listar os movimentos com data, tipo, quantidade, PM resultante e referência (RN-EXC-001).

#### Scenario: Evento corporativo no extrato
- **WHEN** um desdobramento é aplicado
- **THEN** o extrato mostra o movimento do evento com o novo PM

### Requirement: Eventos de posição
A custódia SHALL publicar `custody.movement_posted`, `custody.position_changed` (com quantidades, PM e `realized_pnl`) e `portfolio.daily_snapshot_created`, particionados por `account_id` (Custódia §5).

#### Scenario: Venda realizada
- **WHEN** uma venda swing realiza resultado
- **THEN** `custody.position_changed` traz o resultado realizado usado pela tributação
