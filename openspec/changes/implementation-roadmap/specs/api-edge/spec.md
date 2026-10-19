# Spec Delta

## Purpose

Define a borda HTTP do sistema: o API Gateway (TLS, token, rate limit, CORS, headers, correlação) e os BFFs por canal (web, mobile, desktop e backoffice), que agregam leituras e repassam comandos aos serviços donos, sem regra de negócio.

## ADDED Requirements

### Requirement: TLS obrigatório na borda
A borda SHALL aceitar só HTTPS com TLS 1.2 ou superior (preferindo 1.3), redirecionando ou recusando HTTP (RN-API-001).

#### Scenario: Requisição HTTP simples
- **WHEN** um cliente chama a borda por HTTP sem TLS
- **THEN** a requisição é redirecionada para HTTPS ou recusada

### Requirement: Validação de token na borda
O gateway SHALL validar o access token (assinatura, expiração, realm e revogação) em todas as rotas não públicas, e SHALL repassar a identidade aos BFFs (Catálogo §22, RN-AUTHZ-001).

#### Scenario: Token revogado
- **WHEN** uma sessão é revogada e o cliente usa o access token ainda não expirado
- **THEN** o gateway responde `401`, consultando a lista de revogação

### Requirement: Correlação e headers padrão
O gateway SHALL gerar `X-Correlation-Id` quando ausente e devolvê-lo na resposta, propagar `traceparent`, exigir `X-Client-Channel`/`X-Client-Version` e aplicar `Strict-Transport-Security`, `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy` e `Permissions-Policy` (RN-API §3, RN-API-041).

#### Scenario: Correlação ausente
- **WHEN** a requisição chega sem `X-Correlation-Id`
- **THEN** a resposta traz um `X-Correlation-Id` gerado, igual ao usado nos logs

#### Scenario: Versão de app obsoleta
- **WHEN** `X-Client-Version` está abaixo do mínimo suportado
- **THEN** a resposta é `426 Upgrade Required` com mensagem amigável

### Requirement: Limites de taxa
O gateway SHALL aplicar limites de taxa padrão: 10/min por IP em rotas públicas com atraso progressivo, 600/min de leitura e 120/min de comandos por usuário, 10/h de relatórios por usuário, e SHALL responder `429` com `Retry-After` e headers `RateLimit-*` (RN-API §6).

#### Scenario: Excesso de login
- **WHEN** um IP faz a 11ª tentativa de login no mesmo minuto
- **THEN** recebe `429` com `Retry-After`

### Requirement: CORS e limite de corpo
O gateway SHALL restringir CORS às origens configuradas dos canais (sem curinga) e SHALL rejeitar corpos acima de 64 KB, salvo rotas específicas (RN-API-040, RN-API-042).

#### Scenario: Origem desconhecida
- **WHEN** uma requisição pré-voo vem de uma origem fora da lista
- **THEN** a resposta não inclui os headers de permissão CORS

### Requirement: Rotas "minhas"
Recursos de conta SHALL ser acessados por rotas `/v1/me/...`, com o `account_id` vindo do token e nunca da URL (RN-API-043).

#### Scenario: Tentativa de IDOR
- **WHEN** o cliente tenta informar outra conta na rota ou no corpo de uma rota `/v1/me`
- **THEN** o valor é ignorado e a conta usada é a do token

### Requirement: BFF token handler para web
O BFF web SHALL conduzir o fluxo Authorization Code + PKCE e guardar os tokens em cookies `HttpOnly`, `Secure`, `SameSite=Strict`, com token anti-CSRF; tokens SHALL NOT ficar acessíveis a scripts (RN-AUTH-010, Segurança de aplicação CSRF).

#### Scenario: Login web
- **WHEN** o login web termina
- **THEN** o navegador recebe só cookies `HttpOnly` e nenhum token no corpo da resposta

#### Scenario: Requisição sem token anti-CSRF
- **WHEN** um comando chega ao BFF web com cookie válido e sem o token anti-CSRF
- **THEN** a resposta é `403`

### Requirement: BFFs sem regra de negócio
BFFs SHALL agregar e formatar leituras por canal em lote (sem N+1) e SHALL repassar comandos ao serviço dono, sem implementar regra de negócio (Catálogo §22–24, RN-BE-071).

#### Scenario: Composição da carteira
- **WHEN** o canal pede o painel inicial
- **THEN** o BFF busca saldos, posições e cotações em chamadas agregadas, sem uma chamada por posição

### Requirement: Read-your-writes
Depois de um comando do cliente, o BFF SHALL devolver o estado resultante vindo do serviço dono, e não de uma projeção atrasada (RN-PAD-011).

#### Scenario: Ordem recém-enviada
- **WHEN** o cliente envia uma ordem
- **THEN** a resposta do BFF traz o estado da ordem retornado pelo OMS

### Requirement: Indicação de defasagem
Respostas com dados de projeção (saldo, poder de compra, posição) SHALL trazer `asOf` (RN-PAD-010, RN-LED-021).

#### Scenario: Saldo com as_of
- **WHEN** o cliente consulta saldos
- **THEN** cada saldo traz `asOf` com o instante da última entrada considerada

### Requirement: Auditoria de acesso a dados pessoais
BFFs SHALL emitir eventos `audit.*` para toda consulta a dados pessoais feita pelo backoffice (Catálogo §22–24, RN-AUD-BO-001).

#### Scenario: Suporte consulta cliente
- **WHEN** um usuário `BO_SUPPORT` abre a visão 360° de um cliente
- **THEN** é publicado um evento de auditoria com ator, recurso e justificativa

### Requirement: BFF backoffice com restrição de rede e sessão
O BFF backoffice SHALL aceitar só o realm `backoffice`, origem de rede permitida, sessão de até 8 h e inatividade máxima de 15 min (RN-BO-002, RN-BO-003).

#### Scenario: Token de cliente no backoffice
- **WHEN** um token do realm `customers` chama uma rota do backoffice
- **THEN** a resposta é `403`
