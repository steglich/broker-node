# Spec Delta

## Purpose

Impede que qualquer cliente opere além da sua capacidade financeira e de garantias, sendo o ponto único de serialização do consumo de saldo e de ativos: holds, poder de compra, pré-trade, day trade, margem, venda a descoberto, monitoramento, chamada de margem e zeragem compulsória.

## ADDED Requirements

### Requirement: Serialização por conta
O Risco SHALL processar todas as operações que consomem saldo ou ativos de uma conta em série (partição por `account_id`, escritor único por partição) e SHALL ser o único criador de holds (RN-RSK-001, ADR-0003).

#### Scenario: Compra e saque simultâneos (RSK-030)
- **WHEN** uma compra de R$ 8.000,00 e um saque de R$ 8.000,00 chegam ao mesmo tempo para uma conta com R$ 10.000,00
- **THEN** só uma das operações é aprovada e a outra é recusada por saldo insuficiente

### Requirement: Projeção local sem chamadas síncronas
O Risco SHALL decidir com base numa projeção local alimentada por eventos (saldos do ledger, posições da custódia, preços, ordens abertas, negócios ainda não lançados), sem chamadas síncronas na decisão, e SHALL casar negócios com os lançamentos posteriores pelo `trade_id` para não contar em dobro (RN-RSK-003, ADR-0003).

#### Scenario: Negócio já lançado
- **WHEN** chega o lançamento do ledger de um negócio já contado em `U`
- **THEN** o valor sai de `U` e entra em `P2`, sem alterar o poder de compra

### Requirement: Fail closed e conservadorismo
Sem resposta do Risco nada é aprovado; na dúvida (dado defasado, preço ausente) o Risco SHALL usar o valor que reduz o poder de compra (RN-RSK-002, RN-RSK-004).

#### Scenario: Preço ausente
- **WHEN** a posição de um instrumento não tem preço disponível
- **THEN** ela não conta como garantia no cálculo

### Requirement: Holds
Holds SHALL ter `hold_id`, conta, tipo (`ORDER_CASH`, `ORDER_POSITION`, `ORDER_MARGIN`, `WITHDRAWAL`, `BTC_COLLATERAL`, `BTC_LENT`), recurso, valor original e restante, referência e status (`ACTIVE`, `CONSUMED`, `RELEASED`); o hold de compra é quantidade × preço de referência da ordem + custos estimados com margem de 10%, e SHALL ser reduzido proporcionalmente a cada execução (RN-HLD-001..004).

#### Scenario: Execução parcial abaixo do limite
- **WHEN** uma compra limitada a 10,00 executa metade a 9,90
- **THEN** o hold é reduzido na proporção executada e a diferença de preço é liberada

### Requirement: Holds de condicionais e OCO
Ordens condicionais SHALL reservar desde a criação quando `reserve_on_conditional = true` (padrão); um OCO SHALL reservar uma única vez, pelo maior valor entre as pernas (RN-HLD-005, RN-HLD-006, RN-OCO-004).

#### Scenario: OCO de venda
- **WHEN** um OCO de venda de 100 ações é aprovado
- **THEN** é criado um único hold `ORDER_POSITION` de 100

### Requirement: Holds órfãos
A reconciliação a cada 5 minutos SHALL liberar holds `ACTIVE` cuja referência está terminal e emitir alerta (RN-HLD-007).

#### Scenario: Ordem cancelada sem liberar
- **WHEN** existe hold ativo de uma ordem já `CANCELED`
- **THEN** a reconciliação libera o hold e gera alerta

### Requirement: Poder de compra à vista
O Risco SHALL calcular `BP_cash = P2 + U − H` e aprovar compra `NORMAL` quando o custo reservado for ≤ `BP_cash`; vendas do dia entram em `U` na hora e proventos não pagos não entram (RN-BP-001, RN-BP-003, RN-BP-004).

#### Scenario: Poder de compra (RSK-001)
- **WHEN** a conta tem `P2` R$ 10.000,00, vendeu R$ 2.000,00 hoje e tem holds de R$ 3.000,00
- **THEN** `BP_cash` é R$ 9.000,00

#### Scenario: Compra acima do poder
- **WHEN** a compra exige R$ 9.500,00 com `BP_cash` de R$ 9.000,00
- **THEN** a rejeição é `INSUFFICIENT_BUYING_POWER` com os valores necessário e disponível (RN-PTC-002)

### Requirement: Quantidade disponível para venda
O Risco SHALL calcular `Q_disp` = posição projetada − holds `ORDER_POSITION` − ativos doados; venda até `Q_disp` é coberta e acima disso é venda a descoberto pela diferença; ativos comprados e não liquidados podem ser vendidos (RN-QD-001..003, INV-06).

#### Scenario: Venda sem posição nem margem
- **WHEN** um cliente sem margem habilitada vende mais que `Q_disp`
- **THEN** a rejeição é `INSUFFICIENT_POSITION`

### Requirement: Pré-trade
O pré-trade SHALL seguir a sequência: carregar a projeção, classificar a ordem, verificar habilitações, verificar chamada de margem aberta, calcular hold e `E`/`R` simulados, verificar limites e então criar o hold e responder `APPROVED` com `hold_id` ou `REJECTED` com código e valores, com p99 < 10 ms interno (Risco §11, RN-PTC-001, RNF-003).

#### Scenario: Aprovação
- **WHEN** uma compra coberta cabe no poder de compra
- **THEN** a resposta é `APPROVED` com `hold_id` e `risk.pretrade_approved` é publicado

### Requirement: Hold de saque síncrono
O Risco SHALL oferecer `CreateHold` e `ReleaseHold` (consumido ou cancelado) para saques, usando o saldo sacável da projeção (Contratos §10.2, RN-LED-030).

#### Scenario: Saque liberado após falha
- **WHEN** o ledger chama `ReleaseHold` com `CANCELED`
- **THEN** o hold fica `RELEASED` e o valor volta ao poder de compra

### Requirement: Day trade
Day trade sem alavancagem SHALL usar `BP_cash`; day trade alavancado SHALL exigir perfil `AGGRESSIVE`, termo aceito e `margin_enabled`, com `BP_daytrade` pela alavancagem por tipo (padrão 5×; FIIs/BDRs 2×) e requisito intradiário `Σ |exposição| × preço / alavancagem` (RN-DT-001, RN-DT-002, RN-DT-010, RN-DT-011, RN-BP-002).

#### Scenario: Day trade sem habilitação
- **WHEN** um cliente sem `margin_enabled` envia ordem `DAY_TRADE` acima do `BP_cash`
- **THEN** a rejeição é `DAY_TRADE_LIMIT_EXCEEDED`

### Requirement: Encerramento do day trade alavancado
No horário de aviso (30 min antes do fim do contínuo) o Risco SHALL publicar `risk.day_trade_warning`; no horário de zeragem (15 min antes) SHALL cancelar as ordens ligadas e enviar ordens `MARKET` do canal `SYSTEM` com motivo `DAY_TRADE_AUTO_CLOSE`; o que não puder ser zerado vira swing com as exigências correspondentes (RN-DT-012..014).

#### Scenario: Auto-zeragem
- **WHEN** chega o horário de zeragem com exposição alavancada aberta
- **THEN** o Risco envia ao OMS ordens de zeragem que o cliente não pode cancelar

### Requirement: Patrimônio de garantia e requisito de margem
O Risco SHALL calcular `E` (caixa projetado + compradas elegíveis com haircut por tipo + garantias em dinheiro − vendidas a preço) e `R_inicial`/`R_manutenção` pelas taxas de margem (padrão 50% e 30%) mais o requisito de day trade; instrumento `SUSPENDED` tem haircut 100% (Risco §6.1, §6.2).

#### Scenario: Haircut de FII
- **WHEN** a conta tem R$ 10.000,00 em FII elegível
- **THEN** a contribuição para `E` é R$ 6.000,00

### Requirement: Venda a descoberto
A venda a descoberto SHALL exigir perfil `AGGRESSIVE`, `margin_enabled`, contrato de BTC aceito, instrumento com short habilitado e conta sem chamada de margem, e SHALL ser aprovada só se `E_após ≥ R_inicial_após`; não há short no fracionário e a soma dos shorts do instrumento não passa de `max_short_interest_qty` (RN-SHT-001, RN-SHT-002, RN-SHT-005, RN-SHT-006, RN-SUI-011).

#### Scenario: Margem inicial (RSK-010)
- **WHEN** um short de R$ 10.000,00 é pedido com `E` de R$ 4.000,00 e taxa inicial de 50%
- **THEN** a ordem é rejeitada porque `E` < R$ 5.000,00

#### Scenario: Perfil incompatível
- **WHEN** um cliente `MODERATE` tenta vender a descoberto
- **THEN** a rejeição é `SUITABILITY_NOT_ALLOWED`

### Requirement: Monitoramento e estados de margem
`E` e `R` das contas com short, day trade alavancado ou saldo devedor SHALL ser recalculados a cada execução, mudança de saldo e variação de preço > 0,5% (throttle de 5 s por conta), classificando em `OK`, `WARNING`, `MARGIN_CALL` e `CRITICAL` e publicando `risk.margin_status_changed` (RN-MON-001, Risco §8.2).

#### Scenario: Queda de preço
- **WHEN** o preço sobe e `E` fica entre 0,5 e 1 vez `R_manutenção` numa conta vendida
- **THEN** o estado passa a `MARGIN_CALL`

### Requirement: Chamada de margem
A chamada SHALL ter valor `R_manutenção × 1,1 − E`, prazo padrão D+1 às 14:00 e estados `OPEN`, `MET`, `EXPIRED`, `LIQUIDATED`; com chamada aberta, ordens que aumentam o risco SHALL ser rejeitadas com `ACCOUNT_IN_MARGIN_CALL`; atendida quando `E ≥ R_manutenção × 1,1`; vencida, SHALL iniciar zeragem (RN-MC-001..005).

#### Scenario: Estados e chamada (RSK-020)
- **WHEN** uma chamada aberta não é atendida até o prazo
- **THEN** ela fica `EXPIRED` e a zeragem compulsória começa

### Requirement: Zeragem compulsória
A zeragem SHALL ser disparada por estado `CRITICAL`, chamada vencida, saldo devedor não coberto em 2 dias úteis, horário de day trade ou short sem aluguel, e SHALL seguir o algoritmo: cancelar ordens que aumentam risco, recalcular, zerar day trade alavancado, recomprar vendidas da maior para a menor contribuição, vender compradas do maior para o menor haircut, até `E ≥ R_manutenção × 1,1`, publicando os eventos com o cálculo (RN-LIQ-F-001..004, RN-DEV-004).

#### Scenario: Zeragem até a meta
- **WHEN** a conta entra em `CRITICAL`
- **THEN** o Risco envia ordens `MARKET IOC` do canal `SYSTEM` até atingir a meta e publica `risk.forced_liquidation_completed`

#### Scenario: Fora do contínuo
- **WHEN** a zeragem precisa ocorrer com o mercado em `CLOSED`
- **THEN** as ordens são agendadas para o próximo leilão de abertura

### Requirement: Limites adicionais
O Risco SHALL aplicar exposição máxima de 3× o patrimônio declarado para ordens alavancadas, concentração máxima de 50% de `R` por instrumento alavancado (`CONCENTRATION_LIMIT_EXCEEDED`), máximo de 200 ordens abertas e limite de perda diária opcional do cliente, e o backoffice SHALL poder alterar limites com aprovação (Risco §10, RN-ONB-012).

#### Scenario: Ordem 201
- **WHEN** a conta tem 200 ordens abertas e envia mais uma
- **THEN** a ordem é rejeitada

### Requirement: Recuperação da projeção
O Risco SHALL reconstruir a projeção de cada partição a partir de snapshot e reprocessamento de eventos desde os offsets salvos, ficando sem `readiness` até concluir, com failover em menos de 30 s (Cache e retenção §2, RNF-022).

#### Scenario: Reinício do Risco
- **WHEN** o serviço de risco reinicia
- **THEN** só volta a aprovar ordens depois que a projeção estiver reconstruída
