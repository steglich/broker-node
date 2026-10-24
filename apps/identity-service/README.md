# identity-service

Identidade e acesso dos realms `customers` e `backoffice` (catálogo de serviços §1, Autenticação
§1–§5). Rotas em `contracts/generated/openapi/identity-service.json`.

- **Cadastro** (`POST /v1/customers/register`, só no realm de clientes): senha com 10+ caracteres,
  fora da lista de comuns e sem e-mail, nome ou CPF, guardada com argon2id (`crypto.argon2` do Node).
  E-mail, nome, CPF e telefone ficam cifrados (AES-GCM, chave de dados do serviço); a busca usa o HMAC.
- **Login** (Authorization Code + PKCE S256 em fluxo nativo): `POST /v1/oauth/authorize` com as
  credenciais → código, ou `MFA_REQUIRED` → `POST /v1/oauth/authorize/mfa` (TOTP ou WebAuthn) →
  `POST /v1/oauth/token`. O backoffice sempre passa pelo MFA.
- **Bloqueio** (RN-AUTH-002): contado por e-mail, exista o usuário ou não. Atraso progressivo da 5ª
  falha em diante (`429` com `Retry-After`), bloqueio de 30 min na 10ª e e-mail ao titular.
- **Tokens**: access token ES256 de 10 min (`sub`, `realm`, `account_id`, `roles`, `scope`,
  `session_id`, `amr`, `mfa_time`, `exp`, `iat`, `jti`), JWKS em `/.well-known/jwks.json` com
  rotação (`POST /v1/admin/signing-keys/rotate`). O refresh é opaco, guardado como hash e rotacionado
  a cada uso; o reuso de um refresh já usado revoga a sessão inteira.
- **Sessões**: `GET/DELETE /v1/me/sessions`, `GET /v1/me/devices`. A revogação grava
  `revoked:session:<id>` no Valkey (`RevocationList` do service-kit), que o gateway e os serviços
  consultam. Inatividade: web 30 min, desktop 2 h (até 8 h), backoffice 15 min.
- **Assinatura eletrônica**: `PUT /v1/me/trading-signature` (6 a 8 dígitos) e
  `POST /v1/me/trading-signature/verify` → token `sig+jwt` do escopo (`ORDERS`, `WITHDRAWALS`,
  `SETTINGS`), da sessão, por 5 min (ou até 8 h para ordens). Os serviços conferem com
  `SignatureVerifier` (opção `signature` da rota). 3 erros bloqueiam 30 min; 6, até redefinir com MFA.
- **Step-up**: `POST /v1/me/step-up` renova o `mfa_time`; rotas com `stepUp: true` (ou
  `requireStepUp`) exigem MFA nos últimos 15 min.
- **Recuperação**: `POST /v1/recovery` (sempre `202`), link de 15 min por e-mail mais TOTP ou OTP
  por SMS. Revoga todas as sessões e bloqueia a assinatura por 24 h.
- **Backoffice**: convite (`POST /v1/backoffice/users`, BO_ADMIN), concluído com senha + TOTP;
  `BO_AUDITOR` não acumula papel. Clientes de serviço: `POST /v1/admin/clients` + `client_credentials`.
- **Eventos**: publica `identity.*` em `<ambiente>.identity.events`. Com `CONSUME_CUSTOMER_EVENTS`,
  consome `customer.created` e `account.opened` (o `account_id` do token) e `account.status_changed`
  (`BLOCKED` revoga as assinaturas).

## Runbook

| Situação                         | O que fazer                                                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primeiro administrador           | `docker compose -f infra/compose/compose.yml exec identity-service node dist/bootstrap-admin.js admin@broker.localhost "Nome"`; o convite chega no Mailpit. |
| Cliente bloqueado por tentativas | O bloqueio de 30 min expira sozinho. Para liberar antes, apague a linha do e-mail em `login_throttle` (o hash vem de `identity.login_failed`).              |
| Chave de assinatura vazada       | `POST /v1/admin/signing-keys/rotate`. A anterior continua na JWKS por 24 h: tokens forjados com ela valem até lá (ainda não há "retirar já").               |
| Conta tomada                     | Recuperação de acesso pelo titular, ou revogue as sessões em `DELETE /v1/me/sessions/{id}`; a assinatura fica bloqueada por 24 h.                           |
| Assinatura bloqueada (6 erros)   | O cliente faz MFA (login ou step-up) e cadastra outra em `PUT /v1/me/trading-signature`.                                                                    |
