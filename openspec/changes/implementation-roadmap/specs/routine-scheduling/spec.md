# Spec Delta

## Purpose

Fornece o relógio do ambiente (real, acelerado ou virtual) e o disparo das rotinas temporais do dia de negócio, com idempotência, dependências e recuperação de rotinas atrasadas.

## ADDED Requirements

### Requirement: Modos de relógio
O ambiente SHALL operar num único modo de relógio: `REAL` (tempo UTC real), `ACCELERATED` (tempo virtual que avança `speed_factor` vezes mais rápido) ou `VIRTUAL` (avança só por comando `advance_to(t)`). Um ambiente SHALL NOT misturar modos (RN-CLK-002, RN-CLK-003).

#### Scenario: Relógio virtual parado
- **WHEN** o ambiente está em `VIRTUAL` e ninguém executa `advance_to`
- **THEN** o tempo do ambiente não muda

#### Scenario: Relógio acelerado
- **WHEN** o ambiente está em `ACCELERATED` com 1 dia útil equivalendo a 60 minutos reais
- **THEN** um pregão completo, de `PRE_TRADING` a `CLOSED`, acontece em cerca de 60 minutos reais

### Requirement: Publicação do relógio
Em `ACCELERATED` e `VIRTUAL`, o agendador SHALL publicar `clock.ticked` a cada minuto virtual, e todos os serviços do ambiente SHALL seguir esse tempo (RN-CLK-003, ADR-0009).

#### Scenario: Serviço segue o tempo virtual
- **WHEN** o agendador publica `clock.ticked` com `2026-10-16T13:00:00Z`
- **THEN** os serviços do ambiente passam a usar esse instante como tempo atual

### Requirement: Rotinas do dia de negócio
O agendador SHALL disparar `routine.triggered` para cada rotina da tabela de rotinas (verificação do calendário, liquidação D+2, eventos corporativos, BTC, fases do pregão, EOD de ordens, notas, fechamento, snapshot da brapi, apurações, reconciliações, rotinas mensais), nos horários parametrizados e só nos dias aplicáveis do calendário (Pregão §8).

#### Scenario: Feriado
- **WHEN** o dia é `HOLIDAY`
- **THEN** as rotinas de pregão e de liquidação desse dia não são disparadas

#### Scenario: Rotina mensal
- **WHEN** é o primeiro dia útil do mês
- **THEN** são disparadas a cobrança da taxa de custódia e a apuração do IR do mês anterior

### Requirement: Idempotência de rotina
Toda rotina SHALL ser identificada por `(routine_name, business_date)`, e reexecutar a mesma rotina para a mesma data SHALL NOT duplicar efeitos (RN-ROT-001).

#### Scenario: Disparo duplicado
- **WHEN** a rotina de liquidação de `2026-10-16` é disparada duas vezes
- **THEN** os lançamentos são liquidados uma única vez

### Requirement: Dependências entre rotinas
Rotinas dependentes SHALL declarar pré-requisitos, e o agendador SHALL disparar uma rotina só quando os pré-requisitos daquela data estiverem concluídos (`routine.completed`) (RN-ROT-002).

#### Scenario: Notas antes do fechamento
- **WHEN** chega o horário da geração de notas e o fechamento do dia ainda não foi concluído
- **THEN** a geração de notas espera e é disparada logo após o `routine.completed` do fechamento

### Requirement: Catch-up de rotinas atrasadas
Rotinas atrasadas por indisponibilidade SHALL ser executadas quando o serviço voltar, na ordem correta das datas (RN-ROT-003).

#### Scenario: Sistema fora por um dia
- **WHEN** o sistema fica fora durante todo o dia útil D e volta em D+1
- **THEN** as rotinas de D são executadas em ordem antes das de D+1, e as ordens `DAY` de D são canceladas

### Requirement: Escritor único do agendador
O agendador SHALL ter um único líder ativo por ambiente, com lease e réplica em espera (RN-ENV-021).

#### Scenario: Failover do líder
- **WHEN** o líder do agendador para de renovar o lease
- **THEN** a réplica em espera assume e nenhuma rotina é disparada em duplicidade com efeito
