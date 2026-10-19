# Spec Delta

## Purpose

Transforma eventos de domínio em notificações por canal (in-app, push, e-mail, SMS, desktop) respeitando preferências e prioridades, e mantém alertas de preço e listas de acompanhamento sincronizadas entre canais.

## ADDED Requirements

### Requirement: Catálogo de notificações
O serviço SHALL gerar as notificações do catálogo (ordens, stops, alertas, depósitos, saques, margem, zeragem, day trade, saldo devedor, proventos, notas, DARF, BTC, suitability, segurança, status da conta, onboarding e resumo diário) a partir dos eventos de origem, com canais padrão e prioridade definidos, e as não desativáveis SHALL ignorar a preferência do cliente (Notificações §3).

#### Scenario: Chamada de margem
- **WHEN** chega `risk.margin_call_opened`
- **THEN** a notificação `MARGIN_CALL` é enviada por IN_APP, PUSH, EMAIL e SMS, mesmo com preferências desligadas

### Requirement: Estrutura e templates
Cada notificação SHALL ter id, usuário/conta, código, título e corpo renderizados por template versionado em pt-BR (moeda e data `pt-BR`, fuso `America/Sao_Paulo`), `data` com deep link, prioridade, canais, `created_at`, `read_at` e status de entrega por canal (RN-NOT-G-001, RN-NOT-G-002, RN-NOT-G-009).

#### Scenario: Formatação
- **WHEN** a notificação de depósito de 1500.5 é renderizada
- **THEN** o texto mostra "R$ 1.500,50" e a data no fuso de São Paulo

### Requirement: Privacidade nas notificações
Notificações SHALL NOT conter CPF ou dados sensíveis completos, e com "ocultar valores" ativo o push SHALL mostrar texto genérico (RN-NOT-G-003).

#### Scenario: Ocultar valores
- **WHEN** o cliente ativou "ocultar valores" e uma ordem é executada
- **THEN** o push diz só que há uma atualização de ordem, sem valores

### Requirement: Idempotência e agrupamento
Notificações SHALL ser idempotentes por `(event_id, code, channel)`, e execuções parciais da mesma ordem em menos de 5 s SHALL virar uma única notificação (RN-NOT-G-004, RN-NOT-G-005).

#### Scenario: Parciais em rajada
- **WHEN** três execuções parciais da mesma ordem chegam em 3 s
- **THEN** o cliente recebe uma notificação com o total executado

### Requirement: Silêncio, retentativa e retenção
O horário de silêncio SHALL adiar só notificações de prioridade baixa e média em PUSH e EMAIL; a entrega SHALL ser retentada por canal (até 24 h e-mail, 1 h push) com falha definitiva registrada; a central in-app SHALL reter 90 dias e publicar `notification.*` (RN-NOT-G-006..008).

#### Scenario: Crítica no silêncio
- **WHEN** ocorre uma zeragem durante o horário de silêncio
- **THEN** a notificação é entregue na hora

### Requirement: Preferências e tokens de push
O cliente SHALL gerenciar preferências por código e canal, marcar notificações como lidas e registrar tokens de push de dispositivos (Catálogo §17, Contratos §8).

#### Scenario: Desativar notificação opcional
- **WHEN** o cliente desativa `ORDER_PARTIALLY_FILLED`
- **THEN** as próximas execuções parciais não geram essa notificação

### Requirement: Alertas de preço
O cliente SHALL criar até 50 alertas ativos com condição (`PRICE_ABOVE`, `PRICE_BELOW`, `CHANGE_PERCENT_ABOVE`, `CHANGE_PERCENT_BELOW`, `VOLUME_ABOVE`), valor, fonte (`INTERNAL` só para negociáveis, ou `EXTERNAL`), recorrência (`ONCE` ou `RECURRING` com 15 min entre disparos) e expiração (padrão 90 dias) (Notificações §5, RN-ALR-001).

#### Scenario: Alerta 51
- **WHEN** o cliente tenta criar o 51º alerta ativo
- **THEN** a criação é recusada

### Requirement: Avaliação por cruzamento
Alertas `INTERNAL` SHALL ser avaliados a cada negócio (throttle de 1 s por instrumento) e `EXTERNAL` a cada cotação externa, disparando por cruzamento; na criação com a condição já verdadeira, o cliente escolhe disparar já ou no próximo cruzamento. Alertas SHALL NOT gerar ordens (RN-ALR-002..004).

#### Scenario: Cruzamento para cima
- **WHEN** um `PRICE_ABOVE 40,00` existe e os negócios vão de 39,90 para 40,10
- **THEN** o alerta dispara uma vez e publica `alert.triggered`

### Requirement: Watchlists
O cliente SHALL ter até 20 listas com até 100 instrumentos cada, com "Favoritos" criada na abertura da conta, ordem e colunas configuráveis sincronizadas entre canais, e instrumentos fora do universo marcados como "somente consulta" (RN-WL-001..004).

#### Scenario: Lista padrão
- **WHEN** a conta é aberta
- **THEN** existe a lista "Favoritos" vazia

#### Scenario: Reordenação
- **WHEN** o cliente reordena a lista no desktop
- **THEN** `watchlist.changed` é publicado e o mobile recebe a nova ordem
