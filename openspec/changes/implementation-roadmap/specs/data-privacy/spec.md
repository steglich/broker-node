# Spec Delta

## Purpose

Trata os dados pessoais (fictícios) como reais, aplicando LGPD simulada: criptografia de campo, busca por hash com chave, minimização, direitos do titular, anonimização propagada por eventos e políticas de retenção.

## ADDED Requirements

### Requirement: Criptografia de campo e busca por hash
Dados pessoais sensíveis (nome, CPF, nascimento, nome da mãe, estado civil, endereço, telefone) SHALL ser criptografados em nível de campo, e a busca exata SHALL usar um hash com chave em coluna separada (ex.: `tax_id_hash`) (RN-DB-031, LGPD §1).

#### Scenario: Busca por CPF
- **WHEN** o backoffice busca um cliente pelo CPF
- **THEN** a busca usa o hash com chave e o CPF não é lido em claro do banco para isso

#### Scenario: Leitura direta do banco
- **WHEN** alguém lê a tabela de clientes diretamente
- **THEN** CPF, endereço e telefone aparecem cifrados

### Requirement: Minimização em eventos e logs
Eventos e logs SHALL NOT carregar dados pessoais além de IDs, e o IP SHALL ir só como hash em eventos (completo apenas na auditoria) (LGPD §4, RN-MSG-B-013, RN-BE-051).

#### Scenario: Evento de login
- **WHEN** `identity.login_succeeded` é publicado
- **THEN** o IP aparece como hash

### Requirement: Pedidos do titular
Pedidos de acesso, correção, portabilidade, eliminação e revogação SHALL gerar `privacy_request` com prazo, status e trilha de auditoria; a exportação SHALL ser um job assíncrono em JSON/PDF com cadastro, posições e extratos (RN-LGPD-001, LGPD §3).

#### Scenario: Portabilidade
- **WHEN** o cliente pede seus dados
- **THEN** é criado um `privacy_request` e, ao concluir, o cliente recebe um JSON estruturado por link assinado

### Requirement: Revogação de consentimentos
Consentimentos opcionais SHALL ser apagados na hora ao serem revogados, e revogar a biometria após a aprovação SHALL apagar a selfie, mantendo os documentos fiscais (LGPD §3).

#### Scenario: Revogar biometria
- **WHEN** o cliente aprovado revoga o consentimento de biometria
- **THEN** a selfie é removida do storage e a remoção é auditada

### Requirement: Anonimização propagada
Após o prazo de retenção de conta encerrada, os dados identificáveis SHALL ser substituídos por valores irreversíveis, mantendo IDs técnicos e dados financeiros, e `customer.anonymized` SHALL ser publicado para todos os serviços com projeções do cliente (RN-LGPD-010, RN-LGPD-011).

#### Scenario: Anonimização
- **WHEN** a conta encerrada completa 5 anos
- **THEN** o nome vira "Cliente anonimizado #hash", CPF, endereço, telefone e e-mail são removidos e as projeções nos demais serviços são anonimizadas

### Requirement: Retenção executada por rotina
A política de retenção SHALL ser executada por rotina diária idempotente (documentos de onboarding, cotações, journal do Motor, outbox, inbox, idempotência, notificações, arquivos), registrando na auditoria o que foi removido, sem os dados (RN-RET-001, Cache e retenção §3).

#### Scenario: Solicitação reprovada
- **WHEN** uma solicitação de onboarding reprovada completa 30 dias
- **THEN** os documentos são apagados e a remoção é auditada

### Requirement: Sem dados de prod em dev
Ambientes de desenvolvimento e teste SHALL NOT receber cópia de dados da produção simulada sem anonimização (RN-RET-002).

#### Scenario: Cópia para dev
- **WHEN** alguém exporta dados de prod para o ambiente local
- **THEN** a ferramenta de exportação só aceita a saída anonimizada
