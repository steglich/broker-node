# Spec Delta

## Purpose

Garante liquidez ao mercado simulado com um participante automatizado que cota compra e venda em torno do preço de referência, respeitando estoque finito, limites de inventário, fases do pregão e controles do backoffice.

## ADDED Requirements

### Requirement: Conta própria do FMS
O FMS SHALL operar com conta própria (`account_type = MARKET_MAKER`) e SHALL NOT passar por Risco, custos ou IR, mas SHALL liquidar normalmente no Clearing em D+2 (RN-SMM-022, ADR-0002).

#### Scenario: Negócio do FMS
- **WHEN** um cliente compra do FMS
- **THEN** a ponta do FMS é alocada e liquidada sem nota de corretagem nem custos

### Requirement: Cálculo das cotações
O FMS SHALL calcular `smm_levels` níveis por lado com meio-spread `max(tick, ref × spread_bps / 2 / 10000)`, passo `max(tick, ref × step_bps / 10000)`, inclinação por inventário `−skew × (inv / inv_max) × meio_spread`, compras arredondadas para baixo e vendas para cima ao tick, e quantidade por nível crescendo pelo multiplicador, em lotes (Motor §6.3).

#### Scenario: Cotação com inventário zero
- **WHEN** a referência é R$ 38,50 com parâmetros padrão e inventário zero
- **THEN** o melhor bid fica abaixo de 38,50 e o melhor ask acima, ambos múltiplos de 0,01

#### Scenario: Inventário comprado
- **WHEN** o inventário do FMS está em metade do limite comprado
- **THEN** o centro das cotações fica abaixo da referência

### Requirement: Garantias de forma e limite de inventário
O FMS SHALL garantir `bid_1 < ask_1`, preços > 0 e dentro do túnel de rejeição; com inventário ≥ limite SHALL parar de cotar compra e com inventário ≤ −limite SHALL parar de cotar venda (RN-SMM-001, RN-SMM-002).

#### Scenario: Limite de compra atingido
- **WHEN** o inventário atinge `+smm_inventory_limit_lots`
- **THEN** o FMS não mantém nenhuma oferta de compra

### Requirement: Recotação
O FMS SHALL recotar quando a referência mudar mais de `smm_requote_threshold_ticks`, quando um nível for executado, quando a fase mudar e a cada `smm_refresh_interval`, sempre por cancelamento seguido de nova ordem (RN-SMM-010, RN-SMM-011).

#### Scenario: Nível executado
- **WHEN** o nível 1 de venda do FMS é totalmente executado
- **THEN** o FMS repõe o nível com nova ordem

### Requirement: Varredura de ordens esquecidas
Se a nova cotação cruzar ofertas de clientes em repouso, o FMS SHALL executar contra elas até `smm_max_sweep_lots` por recotação (RN-SMM-012).

#### Scenario: Referência sobe acima de venda do cliente
- **WHEN** a referência sobe e existe venda de cliente abaixo do novo bid do FMS
- **THEN** o FMS compra do cliente até o limite de varredura

### Requirement: Estoque inicial e conservação
Ao ativar um instrumento, o FMS SHALL receber estoque inicial por emissão simulada (`ISSUER_SECURITIES` → custódia do FMS, padrão limite de inventário × lote); o caixa `SMM_CASH` pode ficar negativo, mas o estoque de ativos é finito (RN-SMM-020, RN-SMM-021, INV-02).

#### Scenario: Ativação do instrumento
- **WHEN** um instrumento entra no universo negociável
- **THEN** a custódia do FMS recebe o estoque inicial por movimento em partidas dobradas a partir de `ISSUER_SECURITIES`

### Requirement: Comportamento por fase
O FMS SHALL calcular sem enviar em `PRE_TRADING`; enviar um nível por lado em `ref ± meio_spread` em `PRE_OPENING`, `REOPENING`, `CLOSING_CALL` e `VOLATILITY_AUCTION`; cotar completo em `CONTINUOUS`; e cancelar todas as ofertas em `HALTED`, `POST_CLOSE` e `CLOSED` (Motor §6.6).

#### Scenario: Suspensão
- **WHEN** o instrumento vai a `HALTED`
- **THEN** o FMS cancela todas as suas ofertas daquele instrumento

### Requirement: Referência defasada
Com a referência defasada além de `max_quote_staleness`, o FMS SHALL alargar o spread progressivamente (×2 a cada hora, até ×8) e depois parar de cotar (RN-SMM-032).

#### Scenario: Três horas de defasagem
- **WHEN** a referência está defasada há 3 horas
- **THEN** o spread usado é 8 vezes o configurado

### Requirement: Kill switch
O backoffice SHALL poder desligar o FMS por instrumento ou globalmente (desligar sem aprovação, religar com aprovação); desligado, todas as ofertas são canceladas e o mercado fica só entre clientes (RN-SMM-030, Backoffice §3).

#### Scenario: Desligar globalmente
- **WHEN** o backoffice aciona o kill switch global
- **THEN** todas as ofertas do FMS são canceladas e `smm.status_changed` é publicado

### Requirement: Métricas do FMS
O FMS SHALL publicar inventário, P&L, volume, número de recotações, spread efetivo e tempo com cotação ativa (`smm.metrics`) (RN-SMM-031).

#### Scenario: Painel de mercado
- **WHEN** o backoffice consulta o estado do FMS de PETR4
- **THEN** recebe inventário, P&L e spread efetivo atuais
