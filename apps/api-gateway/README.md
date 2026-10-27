# api-gateway

Borda HTTP (catálogo §22–24, D9). O Traefik termina o TLS (1.2+, HTTP redirecionado) e manda
`api.broker.localhost` para cá; o gateway encaminha para o BFF do canal (`X-Client-Channel`). Sem regra
de negócio e sem banco: só o Valkey (rate limit e lista de revogação).

Na ordem em que roda (`src/app.ts`):

1. **Headers de segurança** (RN-API-041) em toda resposta, inclusive erro: HSTS, CSP fechada,
   `nosniff`, `Referrer-Policy`, `Permissions-Policy`. HTTP que chegue pelo proxy
   (`X-Forwarded-Proto` igual a `http`) volta com `308` para HTTPS (RN-API-001).
2. **CORS** (RN-API-040): só as origens de `CORS_ORIGINS`, com credenciais; origem desconhecida não
   recebe os headers, e comando vindo dela é `403 ORIGIN_NOT_ALLOWED`.
3. **Canal e versão** (API §3): `X-Client-Channel` e `X-Client-Version` obrigatórios (`400`); versão
   abaixo de `MIN_CLIENT_VERSIONS` → `426 UPGRADE_REQUIRED` com mensagem para o usuário.
4. **Corpo** (RN-API-042): 64 KB salvo prefixos configurados (`413`); só JSON (`415`).
5. **Token** (RN-AUTHZ-001): toda rota fora da lista pública (`login`, `register`, `mfa`,
   `password-reset`, `token/refresh`, `logout`) exige access token válido pela JWKS do identity e fora
   da lista de revogação. No canal web o token vem do cookie HttpOnly do token handler. O realm tem
   que ser o do canal (`403 REALM_NOT_ALLOWED`: token de backoffice no web e vice-versa).
6. **Limites** (API §6, janela deslizante num sorted set do Valkey, atômica entre instâncias):
   10/min por IP nas públicas, 600/min de leitura e 120/min de comandos por usuário, 10/h de
   relatórios. Sempre `RateLimit-Limit/Remaining/Reset`; estourou → `429` com `Retry-After`. Login e
   MFA com falha seguida por IP ganham atraso progressivo (3ª falha 250 ms, dobrando até 8 s).
7. **Repasse**: `X-Correlation-Id` (gerado se ausente, o mesmo dos logs e da resposta), `traceparent`
   (propagado ou novo), o IP do cliente em `X-Forwarded-For` e os demais headers do canal; volta
   status, headers e todos os `Set-Cookie` do BFF.

O IP do cliente é o anotado pelo Traefik (`TRUSTED_PROXY_HOPS=1`), nunca o que o cliente escreveu no
`X-Forwarded-For`. A borda usa o relógio real: no sandbox acelerado, quem confere a validade do token
no relógio do ambiente são os serviços (RN-CLK-001).

Só o canal web tem BFF na Fase 1 (`BFF_URLS`); mobile, desktop e backoffice respondem `503
CHANNEL_UNAVAILABLE` até chegarem.

## Runbook

| Situação                                 | O que fazer                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Muitos `429` legítimos                   | Veja `RateLimit-*` na resposta; as chaves ficam em `ratelimit:*` no Valkey (`ratelimit:fail:<ip>` é o atraso). |
| App antigo recebendo `426`               | Ajuste `MIN_CLIENT_VERSIONS` (ex.: `MOBILE=2.3.0`) e suba de novo.                                             |
| Front novo bloqueado por CORS            | Inclua a origem exata em `CORS_ORIGINS` (sem curinga).                                                         |
| `401` logo depois de um logout/revogação | Esperado: a sessão está na lista de revogação até o access token expirar.                                      |
