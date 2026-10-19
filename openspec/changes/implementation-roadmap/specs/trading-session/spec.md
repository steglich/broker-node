# Spec Delta

## Purpose

Controla o dia de negociação: fases do mercado e de cada instrumento, leilões programados, suspensões, circuit breaker e preço de fechamento, enviando as mudanças de fase ao Motor e publicando-as aos demais serviços.

## ADDED Requirements

### Requirement: Fases em dois níveis
A fase SHALL ser mantida no nível de mercado e de instrumento, e a fase efetiva de um instrumento SHALL ser a mais restritiva entre as duas (RN-SES-001).

#### Scenario: Instrumento em leilão
- **WHEN** o mercado está em `CONTINUOUS` e PETR4 está em `VOLATILITY_AUCTION`
- **THEN** a fase efetiva de PETR4 é `VOLATILITY_AUCTION`

### Requirement: Grade horária
As fases `CLOSED`, `PRE_TRADING`, `PRE_OPENING`, `CONTINUOUS`, `CLOSING_CALL`, `POST_CLOSE` SHALL ocorrer conforme `session_schedule` vigente, disparadas por rotinas do agendador; `AFTER_MARKET` SHALL ficar desativado por padrão (Pregão §4.1, Q-04).

#### Scenario: Abertura do dia
- **WHEN** o agendador dispara a rotina das 09:45 num dia útil
- **THEN** o mercado passa a `PRE_OPENING` e o Motor recebe `PhaseChange`

### Requirement: Evento de mudança de fase
Toda mudança de fase SHALL publicar `session.phase_changed` com `scope`, `from`, `to`, `reason`, `effective_at` e `expected_end_at`, e SHALL enviar o comando `PhaseChange` ao Motor pelo tópico de comandos (RN-SES-002, Catálogo §6).

#### Scenario: Consumidores informados
- **WHEN** a fase muda para `CLOSING_CALL`
- **THEN** OMS, FMS e Market Data recebem `session.phase_changed` com `to = CLOSING_CALL`

### Requirement: Abertura e encerramento do dia
A rotina das 07:00 SHALL verificar o calendário e, em dia útil, publicar `session.trading_day_opened`; após o pós-fechamento SHALL publicar `session.trading_day_closed` (Pregão §8).

#### Scenario: Dia sem pregão
- **WHEN** a rotina das 07:00 roda em 24/12 marcado como `NO_TRADING`
- **THEN** nenhum dia de negociação é aberto

### Requirement: Leilões programados e prorrogação
Todo leilão SHALL ter `auction_id`, tipo (`OPENING`, `CLOSING`, `VOLATILITY`, `REOPENING`), início, fim previsto e fim efetivo; se o preço teórico estiver fora do túnel estático no fim previsto, o leilão SHALL ser prorrogado por 2 min, no máximo 3 vezes, e depois seguir `auction_extension_policy` (RN-AUC-001..003).

#### Scenario: Prorrogação
- **WHEN** no fim previsto do leilão de abertura o preço teórico está fora do túnel estático
- **THEN** o leilão é prorrogado por 2 minutos

### Requirement: Suspensões
Suspensões SHALL poder vir do backoffice, de evento corporativo, de referência defasada, de circuit breaker ou de falha técnica do Motor/Market Data (padrão 10 min), por instrumento ou mercado; em `HALTED` as ordens SHALL permanecer no livro, salvo `cancel_all_on_halt`, e a retomada SHALL ser por leilão de 5 min (Pregão §5, RN-HLT-001, RN-HLT-002).

#### Scenario: Suspensão manual
- **WHEN** o backoffice suspende VALE3 com motivo
- **THEN** VALE3 vai a `HALTED`, só cancelamentos são aceitos e a retomada abre um leilão de 5 minutos

#### Scenario: Recuperação do Motor
- **WHEN** o Motor sinaliza que um livro está em recuperação
- **THEN** o instrumento fica `HALTED` com motivo `ENGINE_RECOVERY` até a retomada por leilão

### Requirement: Circuit breaker simulado
O circuit breaker SHALL comparar o Ibovespa externo com o fechamento anterior (níveis 10%, 15% e 20%, com 30 min, 1 h e prazo do backoffice), disparar cada nível no máximo uma vez por pregão, não disparar na última meia hora (parametrizável), levar todos os instrumentos a `HALTED` com `CIRCUIT_BREAKER_L{n}` e retomar por leilão de 15 min. Também SHALL poder ser disparado manualmente e por comando no sandbox (Pregão §6, RN-CB-001..004).

#### Scenario: Nível 1
- **WHEN** o Ibovespa externo cai 10% em relação ao fechamento anterior às 13:00
- **THEN** todos os instrumentos vão a `HALTED` com `CIRCUIT_BREAKER_L1` por 30 minutos

#### Scenario: Última meia hora
- **WHEN** a queda de 10% ocorre às 16:40
- **THEN** o circuit breaker não é disparado

### Requirement: Preço de fechamento
O fechamento de cada instrumento SHALL seguir a precedência: preço da call de fechamento, senão último negócio do contínuo, senão `previous_close`; o fechamento SHALL virar `previous_close` e `band_reference_price` do pregão seguinte, e divergência maior que 5% do fechamento externo SHALL alertar o backoffice (RN-FCH-001..003, RN-INS-040).

#### Scenario: Sem negócios no dia
- **WHEN** um instrumento não tem nenhum negócio no dia
- **THEN** o fechamento é o `previous_close`

### Requirement: Consulta do estado da sessão
O serviço SHALL expor o estado atual do mercado e de cada instrumento e o próximo evento previsto (Contratos §4).

#### Scenario: Consulta durante leilão
- **WHEN** o cliente consulta a sessão de um instrumento em leilão
- **THEN** a resposta traz a fase, o `auction_id` e o fim previsto
