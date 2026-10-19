# Spec Delta

## Purpose

Define as operações administrativas do backoffice como backend: matriz de funções por papel, fluxo genérico de dupla aprovação (maker-checker) e visão de suporte somente leitura com mascaramento.

## ADDED Requirements

### Requirement: Matriz de funções por papel
Cada ação administrativa SHALL ser permitida só aos papéis da matriz de funções e, quando a matriz exigir, SHALL passar por dupla aprovação com o checker indicado (Backoffice §3, RN-AUTHZ-001).

#### Scenario: Papel sem permissão
- **WHEN** um `BO_SUPPORT` tenta alterar a tabela de custos
- **THEN** a resposta é `403`

#### Scenario: Ação sem aprovação
- **WHEN** um `BO_MARKET` suspende um instrumento
- **THEN** a ação é executada na hora, sem solicitação de aprovação

### Requirement: Solicitação de aprovação
Ações que exigem aprovação SHALL virar `approval_request` com tipo, payload proposto, estado atual para comparação, justificativa, maker, criação e expiração (padrão 24 h), publicando `approval.request_created` (RN-MC-BO-001).

#### Scenario: Ajuste financeiro
- **WHEN** um `BO_FINANCE` propõe um ajuste de R$ 5.000,00
- **THEN** é criada uma solicitação `PENDING` com o saldo atual registrado para comparação

### Requirement: Estados e segregação
A solicitação SHALL seguir `PENDING`, `APPROVED`, `REJECTED`, `EXPIRED`, `CANCELED` (pelo maker) e `STALE`; o maker SHALL NOT aprovar a própria solicitação, e políticas de aprovação SHALL definir o papel e os limites do checker (RN-MC-BO-002, RN-BO-001, RN-AJU-002).

#### Scenario: Maker tenta aprovar
- **WHEN** o maker tenta aprovar a própria solicitação
- **THEN** a aprovação é recusada

#### Scenario: Ajuste acima do limite
- **WHEN** um `BO_FINANCE` tenta aprovar um ajuste de R$ 15.000,00
- **THEN** a aprovação é recusada porque exige `BO_ADMIN`

### Requirement: Verificação de estado na aprovação
Ao aprovar, o sistema SHALL verificar se o estado atual do recurso ainda é o registrado na criação; se mudou, a solicitação SHALL ficar `STALE` sem executar (RN-MC-BO-003).

#### Scenario: Estado mudou
- **WHEN** o recurso muda entre a criação e a aprovação
- **THEN** a solicitação fica `STALE` e nada é executado

### Requirement: Execução pelo dono
Aprovada a solicitação, o serviço dono da ação SHALL consumir `approval.request_approved` e executá-la de forma idempotente pelo `approval_request_id` (RN-MC-BO-004, Catálogo §19).

#### Scenario: Evento de aprovação duplicado
- **WHEN** o dono recebe duas vezes a mesma aprovação
- **THEN** a ação é executada uma única vez

### Requirement: Expiração
Solicitações pendentes além do prazo SHALL expirar e publicar `approval.request_expired` (RN-MC-BO-002).

#### Scenario: 24 horas sem decisão
- **WHEN** uma solicitação fica 24 horas `PENDING`
- **THEN** ela passa a `EXPIRED`

### Requirement: Visão de suporte com mascaramento
O suporte SHALL ver os dados do cliente em modo somente leitura, com CPF, e-mail e telefone mascarados; ver o dado completo SHALL exigir justificativa e ser auditado ("break the glass"); não há impersonação (RN-SUP-001, RN-SUP-002).

#### Scenario: Break the glass
- **WHEN** o suporte pede o CPF completo com justificativa
- **THEN** o dado é exibido e um registro de auditoria é criado com a justificativa

### Requirement: Painéis operacionais como API
O BFF backoffice SHALL expor os dados dos painéis (visão geral, cadastro, financeiro, mercado, risco, eventos corporativos, clientes, aprovações, auditoria, integrações), incluindo sagas presas e DLQs (Backoffice §5, RN-PAD-032).

#### Scenario: Saga presa
- **WHEN** uma saga passa do prazo máximo
- **THEN** ela aparece no painel de operações com alerta
