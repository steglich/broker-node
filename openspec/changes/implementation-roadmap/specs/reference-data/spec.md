# Spec Delta

## Purpose

Mantém o cadastro de instrumentos, o universo negociável, as regras de negociação com vigência, o histórico de tickers e o calendário/grade horária do pregão, publicando mudanças para que os demais serviços mantenham cópias locais.

## ADDED Requirements

### Requirement: Cadastro de instrumentos
O serviço SHALL manter instrumentos com `instrument_id` imutável, `symbol` único entre ativos, tipo (`STOCK`, `UNIT`, `REIT`, `ETF`, `BDR`), classe, lote, tick, flags de fracionário, short, day trade e garantia (com haircut), categoria fiscal, status e origem, com padrões por tipo editáveis pelo backoffice (Ativos §2).

#### Scenario: Padrão de FII
- **WHEN** um FII é cadastrado sem sobrescritas
- **THEN** ele fica com `lot_size = 1`, sem fracionário e com `short_sale_enabled = false`

### Requirement: Ticker do fracionário
Instrumentos com `lot_size > 1` SHALL ter fracionário com `odd_lot_symbol = symbol + "F"`; para `lot_size = 1` não há fracionário (RN-INS-002, RN-INS-006).

#### Scenario: Busca do fracionário
- **WHEN** o cliente busca `PETR4F`
- **THEN** o resultado é o instrumento PETR4, quadro `ODD_LOT`

### Requirement: Catálogo completo para consulta
O catálogo completo de tickers SHALL ser sincronizado diariamente a partir de `market_data.catalog_synced`, e todos os instrumentos SHALL estar disponíveis para busca e consulta (RN-INS-010).

#### Scenario: Novo ticker na brapi
- **WHEN** chega `market_data.catalog_synced` com um ticker desconhecido
- **THEN** o instrumento é criado com `tradable = false` e `source = BRAPI`

### Requirement: Universo negociável limitado
Só instrumentos com `tradable = true` SHALL ser negociáveis, até `max_tradable_instruments` (padrão 20). Incluir ou retirar do universo SHALL exigir aprovação, e a retirada SHALL exigir que não haja ordens abertas (RN-INS-011..013, Backoffice §3).

#### Scenario: Universo cheio
- **WHEN** o backoffice tenta incluir o 21º instrumento com o limite padrão
- **THEN** a solicitação é recusada com aviso do limite do orçamento da brapi

#### Scenario: Retirada com ordens abertas
- **WHEN** o backoffice tenta retirar um instrumento com ordens abertas
- **THEN** a retirada é recusada

### Requirement: Inclusão no universo
Incluir um instrumento SHALL publicar `instrument.tradability_changed`, que dispara carga de histórico, primeira cotação, criação dos livros principal e fracionário no Motor e ativação do FMS (RN-INS-014).

#### Scenario: Instrumento incluído
- **WHEN** a inclusão de WEGE3 é aprovada
- **THEN** `instrument.tradability_changed` é publicado e o instrumento fica `PENDING` até a primeira cotação

### Requirement: Status do instrumento
O instrumento SHALL seguir os status `PENDING`, `ACTIVE`, `SUSPENDED` e `DELISTED`, e SHALL ir a `SUSPENDED` automaticamente com motivo `STALE_REFERENCE_PRICE` quando ficar sem cotação válida por mais de `max_quote_staleness` (padrão 2 dias úteis) (Ativos §5, RN-INS-020).

#### Scenario: Cotação defasada
- **WHEN** um instrumento fica 2 dias úteis sem cotação válida
- **THEN** ele passa a `SUSPENDED` e `instrument.status_changed` é publicado

### Requirement: Renomeação de ticker
A renomeação SHALL manter o `instrument_id`, registrar o ticker antigo em `instrument_symbol_history` com vigência e fazer a busca pelo ticker antigo devolver o atual com aviso. Conversões com razão diferente de 1 SHALL virar evento corporativo (RN-INS-030..033).

#### Scenario: Busca por ticker antigo
- **WHEN** o cliente busca um ticker renomeado
- **THEN** recebe o instrumento atual e o aviso "Ticker alterado de X para Y em dd/mm/aaaa"

### Requirement: Regras de negociação com vigência
Os parâmetros de negociação (túneis de rejeição 20%, leilão estático 8% e dinâmico 3%, duração e encerramento aleatório de leilão, máximos por ordem, parâmetros do FMS) SHALL ficar em tabela com vigência, com padrão global e sobrescrita por instrumento, e mudanças SHALL publicar `instrument.trading_rules_changed` (Ativos §7, RNF-070).

#### Scenario: Nova vigência
- **WHEN** um novo túnel de rejeição com vigência a partir de amanhã é aprovado
- **THEN** hoje continua valendo o túnel anterior e amanhã o novo

### Requirement: Calendário e grade horária
O serviço SHALL manter `trading_calendar` (tipos `BUSINESS_DAY`, `HOLIDAY`, `NO_TRADING`, `LATE_OPEN`, `WEEKEND`) com pelo menos o ano corrente e o seguinte, e `session_schedule` com vigência; deve alertar o backoffice faltando 60 dias para o fim do calendário carregado e publicar `calendar.updated` (RN-CAL-001, RN-CAL-003).

#### Scenario: Calendário acabando
- **WHEN** faltam 60 dias para o último dia carregado
- **THEN** o backoffice recebe alerta

### Requirement: Calendário do sandbox
No sandbox, o calendário SHALL tratar todos os dias como úteis, por parâmetro (RN-SBX-002).

#### Scenario: Sábado no sandbox
- **WHEN** o sandbox consulta `is_business_day` para um sábado
- **THEN** a resposta é verdadeira
