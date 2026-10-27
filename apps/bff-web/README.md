# bff-web

BFF do canal web (catálogo §22–24, D9), atrás do api-gateway. Contrato em
`contracts/generated/openapi/bff-web.json`; tabela de repasse em `src/routes.ts`. Sem regra de negócio
(RN-BE-071): agrega leituras e repassa comandos ao dono.

- **Token handler** (RN-AUTH-010, `src/session.ts`): `POST /v1/auth/login` gera o PKCE (S256), chama o
  identity em fluxo nativo (`/v1/oauth/authorize`) com o identificador do navegador (cookie
  `__Host-broker_device`, para o "novo dispositivo") e troca o código no `/v1/oauth/token`. Os tokens
  ficam em cookies `HttpOnly`, `Secure`, `SameSite=Strict`: `__Host-broker_at` (access, `Path=/`) e
  `__Secure-broker_rt` (refresh, `Path=/v1/auth`). O corpo só diz o estado e traz o anti-CSRF. Com MFA,
  o verifier e o desafio vão num cookie cifrado (AES-256-GCM, 5 min) até `POST /v1/auth/mfa/verify`.
  `token/refresh` gira os cookies (reuso do refresh encerra a sessão e limpa tudo), `logout` revoga no
  identity e limpa.
- **Anti-CSRF**: `X-CSRF-Token` = HMAC da sessão, obrigatório em todo comando que veio pelo cookie
  (`403 CSRF_TOKEN_INVALID`). Sai no login, na renovação e em `GET /v1/auth/session` (app recarregado).
  `Authorization: Bearer` explícito dispensa, porque o navegador não o envia sozinho.
- **Assinatura e step-up**: `POST /v1/me/trading-signature/verify` guarda o token de assinatura num
  cookie HttpOnly do escopo (`__Host-broker_sig_settings`...), anexado como `X-Trading-Signature` só
  nos comandos daquele escopo; o step-up troca o cookie do access token.
- **Rotas `/v1/me`** (RN-API-043): `accountId` na consulta ou no corpo é descartado; o dono usa a
  conta do token. Comandos devolvem a resposta do dono (read-your-writes, RN-PAD-011); saldos trazem o
  `asOf` do ledger (RN-PAD-010).
- **Painel** (`GET /v1/me`): perfil, saldos e não lidas, uma chamada por dono em paralelo; seção que
  falhar vem `null` e listada em `unavailable`.
- **Cotações em lote**: `/v1/market/quotes?symbols=` vai numa chamada só ao market-data (até 50).
- **Auditoria**: leitura de dado pessoal (perfil, histórico, contas de saque, onboarding, painel)
  publica `audit.personal_data_accessed` (auditable, sem os valores) pela outbox em `bff-web.events`.
  O banco `bff_web` só guarda a outbox. Para a trilha, inclua `bff-web` em `AUDIT_SOURCE_CONTEXTS`.

Rotas da Fase 1 (Contratos §1–§4, §8): autenticação e sessão, onboarding, perfil, suitability,
termos, contas de saque, saldos, extrato, depósitos, saques, instrumentos, cotação externa, histórico,
calendário e notificações. Os caminhos públicos seguem o documento de contratos (`/v1/auth/register`,
`/v1/auth/password-reset`, `/v1/instruments/{symbol}`, `/v1/market/...`) e o BFF traduz para os do dono.

Diferenças do documento de contratos: `/v1/me/password` não existe (a troca de senha é pela
recuperação de acesso); `/v1/market/session`, book, negócios e candles internos chegam com o
trading-session e o Motor (Fase 2); `/v1/market/quotes` só tem a cotação externa por enquanto. O BFF
repassa o token do usuário; o token de serviço adicional (RN-API-050) fica para quando os serviços o
exigirem.

## Runbook

| Situação                            | O que fazer                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `403 CSRF_TOKEN_INVALID` no front   | O app perdeu o anti-CSRF: chame `GET /v1/auth/session` e mande o `csrfToken` em `X-CSRF-Token`.       |
| Login com MFA volta `LOGIN_EXPIRED` | Passaram os 5 min do desafio ou o cookie não voltou (`Path=/v1/auth`): refaça o login.                |
| `401` em tudo depois de renovar     | O refresh foi reusado (duas abas renovando juntas) e a sessão caiu: entre de novo.                    |
| Rotacionar `CSRF_SECRET`            | Troque o segredo e reinicie: os anti-CSRF antigos deixam de valer (o app relê em `/v1/auth/session`). |
