# Spec Delta

## Purpose

Verifica continuamente as invariantes globais de integridade financeira e de ativos entre serviços, por rotina diária e ao fim de testes E2E e de carga, tratando qualquer diferença como incidente crítico.

## ADDED Requirements

### Requirement: Rotina diária de reconciliação
A rotina das 23:00 SHALL verificar INV-01 (soma dos lançamentos zero por moeda), INV-02 (conservação de ativos), INV-03 (negócio com uma ponta compradora e uma vendedora idênticas) e INV-04 (execuções = `filled_quantity` ≤ `quantity`), publicando o resultado para o relatório de reconciliação (Pregão §8, Relatórios §4).

#### Scenario: Dia consistente
- **WHEN** a rotina roda num dia sem divergências
- **THEN** o resultado registra zero diferenças para INV-01 a INV-04

### Requirement: Reconciliação Motor × OMS × Clearing
Após o fechamento, a soma dos negócios do Motor SHALL ser igual à soma das execuções no OMS e à soma das alocações no Clearing, por instrumento e dia (RN-REC-004).

#### Scenario: Execução perdida
- **WHEN** um negócio do Motor não tem alocação no Clearing
- **THEN** a reconciliação emite alerta crítico com o `trade_id`

### Requirement: Invariantes de saldo e fase
A verificação SHALL cobrir também INV-05 (saldo disponível só negativo por lançamento autorizado do sistema), INV-06 (quantidade disponível só negativa por short autorizado), INV-07 (todo evento rastreável a comando ou rotina) e INV-08 (nenhum negócio fora de fase que permita execução) (Mapa de domínios §4).

#### Scenario: Negócio fora de fase
- **WHEN** existe um negócio com `executed_at` dentro de uma fase `HALTED` do instrumento
- **THEN** a reconciliação reporta violação de INV-08

### Requirement: Diferença é incidente crítico
Qualquer diferença nas reconciliações SHALL gerar alerta crítico com runbook, e as diferenças do ledger na câmara SHALL travar o próximo lote de liquidação (RNF-030, RN-LIQ-004, Observabilidade §7).

#### Scenario: Ledger desbalanceado
- **WHEN** a soma dos lançamentos de BRL é diferente de zero
- **THEN** um alerta crítico é emitido apontando o runbook

### Requirement: Reconciliação como critério de teste
Testes E2E e de carga SHALL terminar executando as reconciliações, e qualquer diferença SHALL reprovar o teste (RN-QA-010).

#### Scenario: Teste de carga
- **WHEN** um teste de carga termina com uma diferença em INV-02
- **THEN** o teste é marcado como reprovado

### Requirement: Testes de caos sem violação
Os testes de caos (matar o líder do Motor durante carga, latência no barramento, banco de um serviço fora, `429`/`5xx` da brapi, mensagens duplicadas e reordenadas) SHALL terminar sem violação de INV-01 a INV-08 e com recuperação dentro dos RTOs (RN-RES-020).

#### Scenario: Mensagens duplicadas
- **WHEN** o teste de caos duplica e reordena mensagens do ledger
- **THEN** as reconciliações terminam sem diferenças
