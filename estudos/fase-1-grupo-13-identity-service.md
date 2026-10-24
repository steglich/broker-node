# Fase 1, grupo 13 — identity-service

> Tarefas 13.1 a 13.6 de `openspec/changes/implementation-roadmap/tasks.md`. Spec: `specs/identity-access/spec.md`. Regras: `broker-docs/docs/07-seguranca/01-autenticacao-e-autorizacao.md` (RN-AUTH-_, RN-SIG-_, RN-AUTHZ-*), `broker-docs/docs/01-dominio/14-backoffice.md` §2 (RN-BO-001..003), catálogo de serviços §1 e catálogo de eventos §1. Design: D10 (identidade própria), D16 (Valkey), D18 (segredos e cifra de campo).

## Visão geral

O identity-service responde a duas perguntas: **quem é você** (credenciais, MFA, sessões, tokens) e **o que você pode fazer agora** (escopos, papéis, assinatura eletrônica, step-up). Tem dois realms com usuários separados: `customers` (cadastro self-service) e `backoffice` (só por convite, com MFA forte obrigatório).

```
app/BFF ──authorize(email, senha, PKCE)──▶ identity ──▶ MFA_REQUIRED ──authorize/mfa(TOTP)──▶ code
app/BFF ──token(code, code_verifier)─────▶ identity ──▶ access (ES256, 10 min) + refresh (opaco)
gateway/serviços ──JWKS──▶ valida o access token ──Valkey──▶ sessão revogada?
serviços ──X-Trading-Signature──▶ SignatureVerifier (escopo, sessão, revogação)
```

O desenho é hexagonal como nos grupos 11 e 12: o domínio (`password-policy.ts`, `policies.ts`, `pkce.ts`) é feito de funções puras sobre `Instant`; os casos de uso (`accounts`, `auth`, `factors`, `signature`, `recovery`) falam com portas; os adaptadores fazem o resto (Postgres, argon2, jose, otplib, simplewebauthn, Valkey, SMTP, message-sink).

## Decisões tomadas no apply

Duas lacunas foram decididas com o dono antes do código:

1. **De onde vem o `account_id`.** O token precisa do `account_id`, e o `account.status_changed` só traz `accountId`. Mas o catálogo dizia que o identity consumia só esse evento. Decisão: o identity também consome `customer.created` (`userId`, `customerId`) e `account.opened` (`accountId`, `customerId`), que já existiam no catálogo. Os payloads não mudam, só a lista de consumidores. Os contratos dos três eventos foram escritos agora, como o catálogo descreve, porque o customer-service (grupo 14) ainda não existe. O consumo fica atrás de `CONSUME_CUSTOMER_EVENTS` até ele publicar.
2. **Por onde saem e-mail e SMS.** O link de recuperação, o convite e o OTP são segredos e não devem ir no payload de um evento. Decisão: saem **direto** do identity, por SMTP para o Mailpit e por HTTP para o message-sink, atrás da porta `Messenger`. Os avisos sem segredo (`new_device_detected`, `mfa_enabled`) continuam como eventos para o notification-service (grupo 18).

Os dois desvios do catálogo estão em `docs/mapeamento-tecnologico.md` ("Conflitos e simplificações").

## 13.1 — Modelo, realms e política de senha

### O modelo

As tabelas do catálogo (`user`, `credential`, `mfa_factor`, `trading_signature`, `session`, `device`, `refresh_token`, `role`, `permission`, `login_attempt`) e mais as que o fluxo pede: `oauth_client`, `login_transaction` (a etapa de MFA), `authorization_code`, `signing_key`, `signature_token`, `one_time_token` (links de recuperação e convite), `login_throttle` e `customer_account`.

O `user` é único por `(realm, email_hash)`: o mesmo e-mail pode existir nos dois realms, como contas separadas (RN-BO-002). E-mail, nome, CPF e telefone ficam **cifrados** com a chave de dados do serviço (envelope encryption do grupo 4). A busca por e-mail usa o HMAC (`BlindIndex`), e é o HMAC que vai nos eventos (`emailHash`). O publicador do grupo 5 recusaria um campo `email`.

### A política (RN-AUTH-001)

- No mínimo 10 caracteres, **sem** regra de composição. Exigir maiúscula e símbolo só produz `Senha@2026`.
- Fora da lista de senhas comuns. O teste também usa a senha sem o sufixo de dígitos e símbolos: `Flamengo2026!` cai como `flamengo`.
- Sem e-mail (nem a parte local), sem pedaço do nome com 3+ letras, sem o CPF (comparado só nos dígitos: `nova-529.982.247-25` cai).

A senha é guardada com **argon2id do próprio Node** (`crypto.argon2`, desde o Node 24.7), no formato PHC (`$argon2id$v=19$m=19456,t=2,p=1$sal$hash`). O design citava o pacote `argon2`, que é nativo e precisa de script de build, bloqueado no `pnpm-workspace.yaml`. Como os parâmetros viajam com o hash, subir o custo depois não invalida os hashes antigos.

## 13.2 — Authorization Code + PKCE, tokens e refresh

### PKCE em fluxo nativo

O OAuth clássico redireciona o navegador para uma tela de login do servidor de autorização. Aqui o login é por API: o BFF (grupo 19) ou o app manda as credenciais para `POST /v1/oauth/authorize` junto com o `code_challenge`, e recebe o código. RN-AUTH-011 admite o "fluxo nativo". O que o PKCE protege continua igual: o código sozinho não vale nada sem o `code_verifier`, que nunca saiu do cliente.

- Só `S256`, porque o OAuth 2.1 aboliu o `plain`. O teste usa o vetor do RFC 7636, apêndice B.
- `redirect_uri` precisa estar cadastrado no cliente e ser o mesmo na troca.
- **Código repetido derruba a sessão** criada com ele (RFC 6749 §4.1.2): se alguém interceptou o código, quem o usou primeiro perde a sessão.

### Access token

ES256 de 10 min, com `typ: at+jwt` e os claims da Autenticação §4: `sub`, `realm`, `account_id`, `roles`, `scope`, `session_id`, `amr`, `exp`, `iat`, `jti`, mais o `mfa_time` (instante do último MFA, para o step-up) e o `client_id`. Um emissor só para os dois realms (`https://auth.broker.localhost`), com o realm no claim. O audit-service (grupo 12) passou a usar esse emissor.

### JWKS rotacionável

As chaves ficam em `signing_key`, com a privada cifrada. Rotacionar cria uma chave ativa nova e aposenta a anterior, que continua na JWKS por 24 h. Isso cobre o token mais longo que ela assinou (o de assinatura "lembrar", 8 h). O teste emite um token, rotaciona e confere que o token antigo ainda é aceito.

### Refresh com rotação e detecção de reuso

O refresh é opaco (256 bits aleatórios) e guardado como **SHA-256**. Basta um hash rápido: diferente de uma senha, o valor tem entropia total e não pode ser adivinhado. A **família** é a sessão:

```
login → R1
R1 → (R1 marcado rotated_at) → R2
R1 de novo → reuso! → revoga a sessão: R2 também morre, o access token cai na lista de revogação
```

O `UPDATE ... WHERE rotated_at IS NULL RETURNING` é a trava: dois usos simultâneos do mesmo refresh não rotacionam os dois, e o segundo conta como reuso.

## 13.3 — Bloqueio por tentativas

O detalhe que faz a diferença: o contador é **por e-mail (hash), exista o usuário ou não** (`login_throttle`). Se o bloqueio fosse por usuário, um e-mail inexistente nunca seria bloqueado, e isso revelaria quais e-mails existem. Assim:

| Falha | Resposta (e-mail real ou inexistente)                        |
| ----- | ------------------------------------------------------------ |
| 1ª–4ª | `401 INVALID_CREDENTIALS`                                    |
| 5ª–9ª | `401`, e a próxima tentativa espera 1, 2, 4, 8, 16 s (`429`) |
| 10ª   | `401`; depois, `429` com `Retry-After: 1800` por 30 min      |

Só o titular real recebe o e-mail de bloqueio, mas a resposta HTTP é idêntica. O teste compara status, código e mensagem do e-mail real com os do inexistente a cada passo. A **latência** também não denuncia: sem usuário, o serviço gasta uma verificação argon2 de mentira (`burn()`).

A linha do `login_throttle` é travada (`FOR UPDATE`) durante a verificação: tentativas simultâneas do mesmo e-mail entram em fila e não escapam do contador. As falhas de MFA contam no mesmo contador, então um ataque ao segundo fator também bloqueia.

## 13.4 — MFA, sessões, dispositivos e revogação

### Fatores

- **TOTP** (`otplib`): ativação em duas etapas, segredo pendente e confirmação com um código válido, que publica `identity.mfa_enabled`. O passo de 30 s do último código aceito fica gravado (`last_used_step`): o mesmo código não serve duas vezes.
- **WebAuthn** (`@simplewebauthn/server`): o desafio fica na transação de login (ou na sessão, no step-up) até a resposta do navegador.
- **SMS** (simulado): só telefone de recuperação, fator fraco (RN-AUTH-003). Não vira etapa de login.

Fora do backoffice, o MFA é opcional, mas quem o ativa passa a usá-lo em todo login. Desativar um fator exige MFA nos últimos 15 minutos (RN-AUTHZ-003).

### Novo dispositivo

O cliente manda um `device_id` estável (gerado pelo app/BFF). Um `device_id` nunca visto gera `identity.new_device_detected`, menos no primeiro login da conta: o primeiro aparelho não é "novo".

### Revogação que o gateway enxerga

O access token é autocontido e vale 10 min. Como derrubá-lo antes? A sessão revogada vai para o Valkey (`revoked:session:<id>`, TTL de 10 min, o tempo de vida do token mais longo). A classe `RevocationList` ficou no **service-kit**, e o `Authenticator` ganhou a opção `revocation`. O gateway (grupo 19) e os serviços consultam com o mesmo código. O teste faz o papel do gateway: o token é aceito, a sessão é revogada pela API e o mesmo token passa a dar `401`.

### Inatividade por canal

O canal vem do cliente OAuth (`bff-web` = WEB, `desktop-app`, `mobile-app`, `bff-backoffice`). A inatividade é conferida na **renovação**: web 30 min, desktop 2 h (o usuário escolhe até 8 h), backoffice 15 min, mobile sem limite no servidor (a biometria é do app). Passou do limite, a sessão é encerrada e o usuário entra de novo.

## 13.5 — Assinatura eletrônica, step-up e recuperação

### O token de assinatura

`POST /v1/me/trading-signature/verify` confere o segredo (6 a 8 dígitos, argon2 próprio) e emite um JWT `typ: sig+jwt` com `sig_scope`, `session_id` e `jti`. Os serviços conferem pelo `SignatureVerifier` do service-kit, declarando na rota:

```ts
service.route({
  method: 'post',
  path: '/withdrawals',
  auth: {},
  signature: 'WITHDRAWALS',
  handler,
});
```

Escopo diferente, outra sessão, outro usuário, expirado ou revogado: tudo responde `403 TRADING_SIGNATURE_REQUIRED`. Cancelar ordem é uma rota sem `signature` (RN-SIG-005). O `Authenticator` recusa um token de assinatura usado como access token.

O segredo nunca coincide com a senha: a assinatura tem no máximo 8 dígitos e a senha tem no mínimo 10 caracteres. A primeira versão tinha uma checagem "assinatura igual à senha" que nunca podia disparar e foi removida.

### Bloqueios (RN-SIG-004)

3 erros: 30 min (`423 SIGNATURE_LOCKED`). Mais 3 depois do bloqueio, ou seja, 6: `SIGNATURE_RESET_REQUIRED`, até redefinir. Redefinir exige MFA recente, e o bloqueio de 24 h da recuperação continua valendo mesmo depois de redefinir.

### Step-up

O claim `mfa_time` diz quando foi o último MFA da sessão. A rota declara `stepUp: true`, ou o caso de uso chama `requireStepUp(ctx.mfaAt, now)` quando a regra é condicional (saque acima de R$ 10 mil). `POST /v1/me/step-up` prova um fator e devolve um access token com `mfa_time` novo. O cenário da spec, saque de R$ 15 mil com MFA há 20 min, está no teste.

### Recuperação (RN-AUTH-004)

`POST /v1/recovery` sempre responde `202`. O link vale 15 min e uma vez só. Concluir exige o segundo fator (TOTP ou OTP por SMS, com 5 tentativas) e a senha nova pela política. Depois: todas as sessões revogadas, o contador de login zerado e a assinatura bloqueada por 24 h. Quem não tem nenhum segundo fator não conclui pela internet (`RECOVERY_SECOND_FACTOR_UNAVAILABLE`) e precisa do atendimento.

## 13.6 — Backoffice, serviços e bloqueio de conta

- **Convite** (`POST /v1/backoffice/users`, só `BO_ADMIN`): a conta nasce `PENDING`. O convidado define a senha **e** confirma o TOTP no mesmo passo. Não existe conta de backoffice sem fator forte, e o último fator forte não pode ser removido.
- **Primeiro admin**: o CLI `node dist/bootstrap-admin.js <email> "<nome>"` envia o convite. Ele não faz nada se o e-mail já existir no backoffice.
- **Segregação** (RN-BO-001): `BO_AUDITOR` sozinho; qualquer combinação com ele dá `422 SEGREGATION_OF_DUTIES`. Ninguém altera os próprios papéis.
- **Client credentials**: cliente confidencial com escopos permitidos. Pedir escopo fora da lista é `invalid_scope`; sem pedir, recebe todos os permitidos. O teste refaz o caso da spec: um serviço sem `risk:pretrade` é barrado pela política da rota de pré-trade com `403`.
- **`account.status_changed` → `BLOCKED`**: revoga os tokens de assinatura ativos do titular (no banco e no Valkey). O teste passa pelo RabbitMQ de verdade, com a conta chegando **antes** do cliente (partições diferentes). A tabela `customer_account` guarda a conta até o `customer.created` chegar.

## O que ficou de fora

- **Proteção contra automação** (desafio progressivo, lista de IPs, Autenticação §6) e o **rate limit**: são da borda, no api-gateway (grupo 19).
- **Restrição de rede do backoffice** (RN-BO-003): também na borda.
- **Fechar as conexões de tempo real** no bloqueio (RN-AUTH-014): é do realtime-gateway (Fase 2), que consome `identity.session_revoked`.
- **MFA obrigatório para operar alavancado e sacar acima do limite**: a regra é de quem executa a operação (risk e ledger). O identity entrega o `amr` e o `mfa_time`.
- **WebAuthn de verdade nos testes**: o fluxo (desafio guardado, credencial certa, contador) é testado com um autenticador falso. A verificação criptográfica é da `@simplewebauthn/server`. Simular um autenticador FIDO2 completo ficou para os testes E2E com navegador.
- **Recuperação com WebAuthn**: só TOTP e SMS. O desafio WebAuthn precisaria de onde morar entre as duas chamadas da recuperação.

## Problemas no caminho

- **`activeSessions` com o relógio do banco**: a primeira versão filtrava `expires_at > now()` do PostgreSQL. Nos testes, com relógio virtual em janeiro de 2026, toda sessão "já tinha expirado" pelo relógio da máquina. Agora o instante vem do relógio do ambiente (RN-CLK-004).
- **Um campo escondendo um método**: o `FakeMessenger` tinha um campo `sms` (a lista) e um método `sms()`. O campo sobrescreve o método na instância, e o envio do SMS dava `500`.
- **Chaves novas a cada `app()`**: o segundo serviço do teste do barramento gerava outra chave-mestra e não conseguia abrir a chave de dados do banco ("unable to authenticate data"). As chaves passaram a ser do ambiente de teste, como os Docker secrets.
- **Desafio do step-up em memória**: a primeira versão guardava o desafio WebAuthn do step-up num `Map`, que quebraria com duas instâncias. Ele foi para a coluna `session.stepup_challenge`.

## Para experimentar

```bash
pnpm env:up core
docker compose -f infra/compose/compose.yml exec identity-service node dist/bootstrap-admin.js admin@broker.localhost "Admin"
# o convite chega em https://mail.broker.localhost
curl --cacert infra/certs/ca/rootCA.pem https://auth.broker.localhost/.well-known/jwks.json
```
