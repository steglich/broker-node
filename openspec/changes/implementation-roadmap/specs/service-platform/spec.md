# Spec Delta

## Purpose

Estabelece o comportamento comum a todo microsserviço: configuração validada, contexto de execução, erros padronizados, idempotência de comandos, logs, métricas, traces, saúde, paginação, limites e documentação de contrato.

## ADDED Requirements

### Requirement: Configuração validada na inicialização
Todo serviço SHALL ler a configuração do ambiente, validar todos os valores ao iniciar e encerrar com erro claro se algum for inválido. Segredos SHALL vir só de fonte de segredos e nunca aparecer em logs (RN-BE-060, RN-BE-061, RN-PAD-070).

#### Scenario: Variável obrigatória ausente
- **WHEN** um serviço inicia sem a URL do banco
- **THEN** o processo encerra com código de erro e uma mensagem indicando a variável faltante, sem expor segredos

### Requirement: Contexto de execução em todo comando
Todo comando SHALL receber um contexto com `actor`, `account_id` (se houver), `correlation_id`, `causation_id`, `idempotency_key`, `channel`, `ip`, `user_agent` e `requested_at` (relógio do sistema) (RN-BE-011).

#### Scenario: Propagação de correlação
- **WHEN** uma requisição chega com `X-Correlation-Id: abc`
- **THEN** o mesmo valor aparece nos logs, na resposta e nos eventos gerados pelo comando

### Requirement: Autorização no caso de uso
A autorização SHALL ocorrer na camada de aplicação de cada serviço, verificando se o ator pode agir sobre o recurso, além da verificação na borda. Recursos de outro dono SHALL responder como inexistentes (RN-BE-012, RN-AUTHZ-001, RN-AUTHZ-002).

#### Scenario: Ordem de outra conta
- **WHEN** o cliente A consulta uma ordem da conta B
- **THEN** a resposta é `404`, sem revelar que a ordem existe

### Requirement: Erros no formato Problem Details
Erros de API SHALL usar RFC 9457 (`application/problem+json`) com `type`, `title` e `detail` em pt-BR, `status`, `code` em `UPPER_SNAKE_CASE`, `instance`, `correlationId` e, quando houver, `errors[]` com `field` e `code`. Erros técnicos SHALL ser convertidos em `INTERNAL_ERROR` ou `SERVICE_UNAVAILABLE`, sem detalhes internos (RN-BE-020, RN-BE-030..032, RN-API §5).

#### Scenario: Erro de negócio
- **WHEN** um comando viola uma regra de negócio
- **THEN** a resposta é `422` com o `code` específico do domínio e o `correlationId`

#### Scenario: Falha técnica
- **WHEN** o banco fica indisponível durante uma consulta
- **THEN** a resposta é `503` com `code = SERVICE_UNAVAILABLE` e sem stack trace

### Requirement: Idempotência de comandos HTTP
Todo `POST` que cria recurso ou executa ação com efeito SHALL exigir `Idempotency-Key`. A mesma chave com o mesmo corpo devolve a mesma resposta por 24 h; a mesma chave com corpo diferente devolve `409 IDEMPOTENCY_KEY_REUSED` (RN-PAD §4, RNF-032).

#### Scenario: Repetição da mesma requisição
- **WHEN** o cliente reenvia um depósito com a mesma `Idempotency-Key` e o mesmo corpo
- **THEN** recebe a resposta original e nenhum novo depósito é criado

#### Scenario: Reuso com corpo diferente
- **WHEN** o cliente reenvia a mesma `Idempotency-Key` com outro valor
- **THEN** recebe `409` com `code = IDEMPOTENCY_KEY_REUSED`

### Requirement: Concorrência otimista
Agregados mutáveis SHALL ter `version`. Um conflito de versão SHALL resultar em nova tentativa (até 3 vezes, quando o comando é idempotente e veio de evento) ou em `409` ao cliente (RN-BE-041, RN-API §3 `If-Match`).

#### Scenario: Alteração concorrente via API
- **WHEN** duas alterações chegam com a mesma `If-Match`
- **THEN** a primeira é aplicada e a segunda recebe `409`

### Requirement: Logs estruturados com mascaramento
Logs SHALL ser JSON com `timestamp` (UTC), `level`, `service`, `environment`, `version`, `correlation_id`, `trace_id`, `span_id`, `message`, `event` e `wall_clock_at`. Senhas, tokens, segredos, CPF completo e documentos SHALL ser mascarados automaticamente por nome de campo (RN-BE-050..052, RN-CLK-004).

#### Scenario: Campo sensível no log
- **WHEN** um log inclui um objeto com o campo `password` ou `taxId`
- **THEN** o valor sai mascarado no log emitido

### Requirement: Métricas, traces e saúde
Todo serviço SHALL expor métricas RED por rota e consumidor, propagar W3C Trace Context em HTTP e mensagens, e oferecer `liveness`, `readiness` (dependências críticas acessíveis e estado carregado) e `info` (versão, commit, ambiente, início) (RN-OBS §2, §4, §5, RN-CICD-020, RNF-060).

#### Scenario: Readiness durante recuperação
- **WHEN** um serviço com estado em memória ainda está reconstruindo o estado
- **THEN** `readiness` responde não pronto e `liveness` responde vivo

#### Scenario: Trace de ponta a ponta
- **WHEN** um comando HTTP gera um evento consumido por outro serviço
- **THEN** os spans do produtor e do consumidor pertencem ao mesmo trace

### Requirement: Paginação e consultas limitadas
Listas que crescem SHALL usar paginação por cursor (`limit` padrão 50, máximo 200, `nextCursor`), e nenhuma consulta SHALL ser executada sem limite. Filtros de período SHALL limitar a 1 ano por consulta (RN-BE-070, RN-API-020..023).

#### Scenario: Limite acima do máximo
- **WHEN** o cliente pede `limit=500`
- **THEN** a resposta usa no máximo 200 itens ou devolve `400` de validação, conforme o contrato da rota

### Requirement: Convenções de API
APIs SHALL usar versão no caminho (`/v1`), rotas em `kebab-case` no plural, campos `camelCase`, enums `UPPER_SNAKE_CASE`, dinheiro como objeto `{amount: string, currency}`, preços e percentuais como string decimal, datas ISO 8601 UTC, e `Cache-Control: no-store` em respostas com dados de conta (RN-API-004, RN-API-005, RN-API-010, ADR-0010).

#### Scenario: Dinheiro serializado como string
- **WHEN** a API devolve um saldo
- **THEN** o valor aparece como `{"amount": "3851.15", "currency": "BRL"}` e nunca como número JSON

### Requirement: Contratos legíveis por máquina
Cada serviço SHALL publicar sua API síncrona em contrato legível por máquina, versionado junto ao código, e SHALL ter README com responsabilidade, execução local, configuração, eventos publicados/consumidos, dependências e runbook (RN-BE-003, RN-BE-080, RN-OBS-010).

#### Scenario: Contrato desatualizado
- **WHEN** uma rota implementada diverge do contrato publicado
- **THEN** o teste de contrato do pipeline falha

### Requirement: Chamadas síncronas internas protegidas
Chamadas síncronas entre serviços SHALL ter timeout explícito, retentativa limitada só para operações idempotentes, disjuntor e autenticação de serviço. Novas chamadas síncronas no núcleo além de pré-trade e hold de saque SHALL ser proibidas sem ADR (RN-ARQ-001, RN-ARQ-002, RN-API-050).

#### Scenario: Dependência lenta
- **WHEN** a dependência síncrona excede o timeout configurado repetidamente
- **THEN** o disjuntor abre e as chamadas seguintes falham rápido até a meia-abertura

### Requirement: Feature flags por ambiente
Funcionalidades em construção SHALL poder ser desligadas por feature flag por ambiente e, opcionalmente, por conta (RN-PAD-072, RN-CICD-014).

#### Scenario: BTC desligado
- **WHEN** `btc_enabled = false`
- **THEN** as rotas e consumidores de BTC recusam comandos com erro de funcionalidade indisponível
