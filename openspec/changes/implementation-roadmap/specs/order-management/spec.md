# Spec Delta

## Purpose

Recebe, valida e gerencia o ciclo de vida das ordens do cliente e do sistema (simples, condicionais e compostas), integrando-se ao Risco de forma síncrona e ao Motor por comandos assíncronos, com a execução do Motor como fonte da verdade.

## ADDED Requirements

### Requirement: Idempotência por client_order_id
O `client_order_id` SHALL ser único por conta nas últimas 24 h; um envio repetido SHALL devolver a ordem existente com `200`, sem novo efeito (Ordens §2, Ordens §9 item 2).

#### Scenario: Reenvio da mesma ordem
- **WHEN** o canal reenvia uma ordem com o mesmo `client_order_id`
- **THEN** recebe `200` com a ordem já criada e nenhuma nova ordem é enviada ao Motor

### Requirement: Validações determinísticas antes do Risco
O OMS SHALL validar, nesta ordem: autenticação e assinatura, idempotência, conta (status, termos, suitability para compra), instrumento (existe, negociável, `ACTIVE`, livro disponível), fase, campos, quantidade (lote e máximo), preço (tick, túnel, coerência do stop), notional, suitability e limite de taxa (20/s e 200/min por conta). As falhas 1 a 11 SHALL gerar `REJECTED` sem chamar o Risco e ficar registradas, exceto falha de autenticação (Ordens §9, RN-VAL-001).

#### Scenario: Primeira falha prevalece
- **WHEN** uma ordem tem lote inválido e preço fora do túnel
- **THEN** a rejeição é `INVALID_LOT_QUANTITY`

#### Scenario: Excesso de ordens
- **WHEN** a conta envia a 21ª ordem nova no mesmo segundo
- **THEN** a ordem é rejeitada com `RATE_LIMIT_EXCEEDED`

### Requirement: Pré-trade síncrono fail closed
Após as validações, o OMS SHALL chamar o pré-trade do Risco (com criação do hold) com timeout de 200 ms; timeout ou indisponibilidade SHALL rejeitar a ordem com `RISK_UNAVAILABLE`, e nenhuma ordem SHALL ser enviada ao Motor sem aprovação (RN-FLX-001, RN-RSK-002).

#### Scenario: Risco lento
- **WHEN** o Risco não responde em 200 ms
- **THEN** a ordem fica `REJECTED` com `RISK_UNAVAILABLE`

### Requirement: Aceite assíncrono
Uma ordem aprovada SHALL passar a `PENDING_NEW`, publicar `order.accepted` e o comando ao Motor pela outbox, e o canal SHALL receber `202` com o estado atual (RN-FLX-002, Ordens §11).

#### Scenario: Ordem limitada no contínuo
- **WHEN** uma ordem limitada válida é aprovada pelo Risco em `CONTINUOUS`
- **THEN** a resposta é `202` com status `PENDING_NEW` e o Motor recebe o comando particionado pelo instrumento

### Requirement: Máquina de estados da ordem
A ordem SHALL seguir só as transições do diagrama (`RECEIVED`, `SCHEDULED`, `PENDING_TRIGGER`, `PENDING_NEW`, `NEW`, `PARTIALLY_FILLED`, `PENDING_REPLACE`, `PENDING_CANCEL`, `FILLED`, `CANCELED`, `REJECTED`, `EXPIRED`); transições inválidas SHALL ser rejeitadas, e cada transição SHALL gravar `order_event` imutável e publicar evento de domínio e `order.updated` (RN-ORD-020, RN-ORD-021).

#### Scenario: Transição inválida (ORD-001..020)
- **WHEN** algo tenta levar uma ordem de `FILLED` para `NEW`
- **THEN** a transição é rejeitada e o estado não muda

### Requirement: Execução do Motor é a verdade
O OMS SHALL aplicar execuções recebidas em qualquer estado não terminal, inclusive `PENDING_CANCEL` e `PENDING_REPLACE`, descartar duplicatas por `engine_seq` e pedir replay ao detectar lacuna. Para toda ordem, `filled_quantity ≤ quantity` e a soma das execuções é igual a `filled_quantity` (RN-ORD-022, RN-ORD-023, INV-04).

#### Scenario: Execução durante cancelamento
- **WHEN** chega uma execução total para uma ordem em `PENDING_CANCEL`
- **THEN** a ordem fica `FILLED`

#### Scenario: Lacuna de sequência
- **WHEN** o OMS recebe `engine_seq` 101 depois de 99 para um instrumento
- **THEN** pausa a aplicação daquele instrumento e pede replay a partir de 100

### Requirement: Tipos e proteção da ordem a mercado
O OMS SHALL aceitar `MARKET`, `LIMIT`, `STOP_LIMIT`, `STOP_MARKET`, `TAKE_PROFIT_LIMIT`, `TAKE_PROFIT_MARKET` e `TRAILING_STOP`; a `MARKET` SHALL receber preço de proteção implícito (padrão 2% sobre o melhor preço inicial, ou sobre `band_reference_price` sem contraparte), arredondado ao tick e limitado ao túnel de rejeição (Ordens §3, RN-ORD-001..003).

#### Scenario: Proteção da compra
- **WHEN** chega uma compra `MARKET` com melhor oferta de venda a R$ 10,00
- **THEN** o preço de proteção é R$ 10,20

### Requirement: Validades
O OMS SHALL suportar `DAY`, `GTC` (até 30 dias corridos), `GTD` (dia útil futuro até +90 dias), `IOC` e `FOK`; `MARKET` aceita só `DAY` em leilão, `IOC` ou `FOK` (no contínuo, `DAY` vira `IOC`); `IOC`/`FOK` não são aceitas em leilão; `FOK` não permite divisão automática (Ordens §4, RN-ORD-010, RN-ORD-011).

#### Scenario: IOC em leilão
- **WHEN** uma ordem `IOC` chega com o instrumento em `PRE_OPENING`
- **THEN** a ordem é rejeitada com `PHASE_NOT_ALLOWED`

#### Scenario: GTC vencida
- **WHEN** uma ordem `GTC` completa 30 dias corridos sem execução total
- **THEN** ela fica `EXPIRED`

### Requirement: Ordens agendadas
Ordens enviadas em `CLOSED`, `PRE_TRADING` ou `POST_CLOSE` SHALL ficar `SCHEDULED`, com reserva no Risco na criação, e SHALL ser enviadas ao Motor no início da `PRE_OPENING` do próximo dia útil, por ordem de chegada (RN-SES-003).

#### Scenario: Ordem à noite
- **WHEN** o cliente envia uma compra limitada às 20:00
- **THEN** a ordem fica `SCHEDULED` e é enviada às 09:45 do próximo dia útil

### Requirement: Regras por fase
Na `CLOSING_CALL` só ordens limitadas SHALL ser aceitas e ordens existentes SHALL NOT ter preço piorado nem quantidade aumentada; em `HALTED` só cancelamento é aceito (RN-SES-004, RN-ALT-006, RN-CAN-004).

#### Scenario: Aumento na call
- **WHEN** o cliente tenta aumentar a quantidade de uma ordem durante a `CLOSING_CALL`
- **THEN** a alteração é rejeitada com `PHASE_NOT_ALLOWED`

### Requirement: Alteração de ordem
Só `quantity`, `limit_price`, `stop_price`, `trailing_*` e validade SHALL ser alteráveis; a nova quantidade SHALL ser maior que `filled_quantity`; a alteração SHALL exigir a `version` atual (`ORDER_VERSION_CONFLICT`) e SHALL passar de novo pelo Risco (RN-ALT-001..005).

#### Scenario: Versão desatualizada
- **WHEN** o cliente altera uma ordem com `version` antiga
- **THEN** a resposta é `409` com `ORDER_VERSION_CONFLICT`

### Requirement: Cancelamento
Qualquer ordem não terminal SHALL poder ser cancelada; em `PENDING_NEW` o cancelamento fica enfileirado até a confirmação do Motor. O cancelamento em massa (conta, instrumento, lado) SHALL gerar um evento por ordem, com os motivos padronizados de `cancel_reason` (RN-CAN-001..003).

#### Scenario: Cancelar todas do instrumento
- **WHEN** o cliente cancela todas as ordens de PETR4
- **THEN** cada ordem aberta de PETR4 gera seu próprio `order.canceled` com `CUSTOMER_REQUEST`

### Requirement: Fim do dia
A rotina de EOD SHALL cancelar as ordens `DAY` com `END_OF_DAY` e expirar as `GTD` vencidas; as `GTC`/`GTD` vigentes permanecem (Pregão §8, RN-REC-005).

#### Scenario: Ordem DAY aberta às 17:05
- **WHEN** a rotina de EOD roda com uma ordem `DAY` parcialmente executada
- **THEN** o restante é cancelado com `END_OF_DAY`

### Requirement: Divisão lote/fracionário
Com `auto_split = true`, uma ordem no ticker principal com quantidade não múltipla do lote SHALL virar ordem-mãe com filhas no principal e no fracionário; o estado da mãe SHALL ser derivado das filhas (com alerta `PARTIAL_REJECTION`); com `auto_split = false`, SHALL ser rejeitada com `INVALID_LOT_QUANTITY` (RN-INS-004, RN-INS-005, RN-CMP-001..003).

#### Scenario: Divisão 250 (ORD-030)
- **WHEN** o cliente compra 250 PETR4 com lote 100 e `auto_split = true`
- **THEN** são criadas filhas de 200 no principal e 50 no fracionário, e a mãe fica `FILLED` só quando as duas estiverem `FILLED`

### Requirement: Ordens condicionais
Ordens stop, take profit e trailing SHALL ficar `PENDING_TRIGGER` no OMS, ser avaliadas só em `CONTINUOUS` pelo último preço do livro principal (`market_data.trade_printed`), disparar pela ordem de criação, revalidar o Risco no disparo (`RISK_REJECTED_ON_TRIGGER` se reprovado) e ser rejeitadas na criação se disparariam imediatamente, salvo `allow_immediate_trigger` (RN-STP-001..005, RN-ORD-004, ADR-0006).

#### Scenario: Stop loss disparado
- **WHEN** um `STOP_MARKET` de venda com `stop_price` 37,00 está armado e sai um negócio a 36,99
- **THEN** a ordem passa a `PENDING_NEW` como `MARKET` e `order.triggered` é publicado

#### Scenario: Abertura pula o stop
- **WHEN** o leilão de abertura fecha abaixo do `stop_price` de um stop de venda
- **THEN** o stop dispara logo após o início do contínuo

### Requirement: Trailing stop
O disparo do trailing SHALL acompanhar o melhor preço observado (só sobe na venda, só desce na compra) pela distância em valor ou percentual, arredondado ao tick de forma conservadora, respeitando `trailing_step`, e publicar `order.trailing_adjusted` com throttle de 1/s por ordem para os canais (RN-TRL-001..005).

#### Scenario: Sequência de preços (ORD-050)
- **WHEN** um trailing de venda com distância R$ 1,00 é criado com último preço 10,00 e os negócios seguintes são 10,50, 10,20 e 9,49
- **THEN** o disparo vai a 9,00, depois a 9,50, não se move em 10,20 e a ordem dispara em 9,49

### Requirement: OCO
Um grupo OCO SHALL ter duas pernas do mesmo instrumento, lado e quantidade; uma execução numa perna SHALL reduzir a outra na mesma quantidade, execução total SHALL cancelar a outra com `OCO_SIBLING_FILLED`, e cancelar uma perna SHALL cancelar o grupo. O disparo do stop SHALL primeiro cancelar a perna limitada (`CANCEL_THEN_SEND`) e a sobre-execução SHALL gerar `oco.overfill_detected` (RN-OCO-001..005).

#### Scenario: Execução parcial (ORD-040)
- **WHEN** a perna alvo de um OCO de 300 executa 100
- **THEN** a perna stop passa a 200

#### Scenario: Sobre-execução
- **WHEN** as duas pernas executam ao mesmo tempo além da quantidade do grupo
- **THEN** `oco.overfill_detected` é publicado e o caso vai para revisão do backoffice

### Requirement: Bracket e iceberg
O bracket SHALL criar ou ajustar o OCO de saída a cada execução da entrada, e cancelar a entrada SHALL NOT cancelar o OCO das quantidades já executadas. O iceberg SHALL expor só `display_quantity` (múltiplo do lote, só `LIMIT`) e ser uma só ordem para o cliente e o Risco (RN-BRK-001..003, RN-ICE-001, RN-ICE-002).

#### Scenario: Entrada parcial do bracket
- **WHEN** a entrada de um bracket de 500 executa 200
- **THEN** existe um OCO de saída de 200

### Requirement: Ordens do sistema
O OMS SHALL aceitar ordens de zeragem do Risco no canal `SYSTEM` com origem `RISK_FORCED`, que o cliente não pode cancelar, e SHALL cancelar ordens por bloqueio de conta, deslistagem e evento corporativo (`GTC`/`GTD` na data-ex de desdobramento/grupamento) com os motivos correspondentes (RN-LIQ-F-003, RN-LIQ-F-005, RN-ACC-011, RN-ORD-012).

#### Scenario: Cliente tenta cancelar zeragem
- **WHEN** o cliente tenta cancelar uma ordem do canal `SYSTEM`
- **THEN** o cancelamento é recusado

### Requirement: Consultas e simulação de custos
O OMS SHALL oferecer consulta de ordens com filtros e cursor, detalhe com histórico, consulta de execuções e simulação de custos da boleta (como swing isolado, com nota explicativa) (Contratos §5, RN-FEE-040, RN-FEE-041).

#### Scenario: Estimativa na boleta
- **WHEN** o cliente simula a compra de 100 PETR4 a R$ 38,50 com a tabela de referência
- **THEN** a estimativa traz emolumentos R$ 0,19, liquidação R$ 0,96 e total R$ 1,15
