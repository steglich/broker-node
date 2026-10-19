# Spec Delta

## Purpose

Mantém uma trilha de auditoria imutável e verificável, encadeada por hash, de todos os comandos que alteram estado e das consultas a dados pessoais, consultável só por papéis autorizados.

## ADDED Requirements

### Requirement: Captura de eventos auditáveis
O serviço de auditoria SHALL consumir todos os eventos marcados `auditable` e os eventos `audit.*` dos BFFs, registrando autenticação, comandos financeiros, ações de risco, ações e consultas do backoffice, mudanças de configuração e acessos a dados pessoais (Segurança de aplicação §3.1, Catálogo §20).

#### Scenario: Ordem criada
- **WHEN** uma ordem é criada
- **THEN** existe um registro de auditoria com ator, instante, origem e ação

### Requirement: Conteúdo do registro
Cada registro SHALL ter `actor_id`, `actor_roles`, `action`, `resource_type`, `resource_id`, `before` e `after` com dados sensíveis mascarados, `justification`, `approval_request_id`, `ip`, `user_agent`, `occurred_at` e `correlation_id` (RN-AUD-BO-001, RN-AUD-003).

#### Scenario: Troca de telefone
- **WHEN** o cliente altera o telefone
- **THEN** o registro mostra que o telefone mudou, sem gravar o número completo

### Requirement: Append-only encadeado por hash
A trilha SHALL ser append-only com `seq` contínuo e `hash = H(prev_hash || conteúdo canônico)`; nem administradores SHALL conseguir alterar ou apagar registros pela aplicação, e o usuário do banco SHALL NOT ter `UPDATE`/`DELETE` na tabela (RN-AUD-001, RN-AUD-004, RN-AUD-BO-002).

#### Scenario: Adulteração detectada
- **WHEN** um registro é alterado diretamente no banco
- **THEN** a verificação diária da cadeia detecta a quebra e emite alerta crítico

### Requirement: Ancoragem diária
O hash do último registro do dia SHALL ser publicado num storage separado com retenção imutável (RN-AUD-002).

#### Scenario: Âncora do dia
- **WHEN** a rotina diária termina
- **THEN** o hash final do dia está gravado no storage de âncoras e não pode ser sobrescrito

### Requirement: Consulta restrita e auditada
A consulta à trilha SHALL ser permitida só a `BO_AUDITOR` e `BO_ADMIN`, por ator, ação, recurso e período, e a própria consulta SHALL gerar registro de auditoria (RN-AUD-005).

#### Scenario: Operador financeiro consulta
- **WHEN** um `BO_FINANCE` tenta consultar a trilha
- **THEN** a resposta é `403`

### Requirement: Retenção da trilha
A trilha SHALL ser mantida por 5 anos e depois movida para arquivamento frio imutável, registrando as remoções feitas pela política de retenção sem os dados (Cache e retenção §3, RN-RET-001).

#### Scenario: Rotina de retenção
- **WHEN** a rotina de retenção arquiva registros antigos
- **THEN** um registro de auditoria informa o que foi arquivado, sem o conteúdo
