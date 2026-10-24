# Tasks

> Organização: grupos 1–10 = **Fase 0**, 11–20 = **Fase 1**, 21–28 = **Fase 2**, 29–34 = **Fase 3**, 35–38 = **Fase 4**, 39–41 = **Fase 5**, 42 = **Fase 6 (backend dos canais)**, 43–47 = **Fase 7**. Cada serviço novo entrega junto: migrações, testes (unitários citando `RN-*`, integração, contrato), contrato OpenAPI/AsyncAPI, README com runbook e entrada em `docs/mapeamento-tecnologico.md`.

## 1. Fase 0 — Monorepo e ferramentas

- [x] 1.1 Criar o monorepo pnpm + Turborepo com `apps/`, `packages/`, `contracts/`, `scenarios/`, `infra/` e `docs/`, fixando Node 24 (`.nvmrc`, `engines`); verificar que `pnpm install` e `pnpm turbo run build` passam vazios
- [x] 1.2 Criar `packages/tsconfig` (strict, ESM) e `packages/eslint-config` com Prettier, `import/no-restricted-paths` (domain sem adapters) e proibição de `Date.now`/`new Date()`/`Math.random` em `**/domain/**`; verificar com um arquivo de teste que a regra falha
- [x] 1.3 Configurar Vitest no workspace (cobertura por pacote, limite de 80% em `domain/`) e verificar que `pnpm test` roda um teste de exemplo
- [x] 1.4 Escrever `docs/mapeamento-tecnologico.md` com o mapeamento conceito → tecnologia do design (D1–D22) e verificar que cobre barramento, banco, cache, storage, observabilidade, cofre e registro de esquemas (RN-BE-082)

## 2. Fase 0 — Infraestrutura em Docker

- [x] 2.1 Criar `infra/compose/compose.yml` com PostgreSQL 17, RabbitMQ 4 (plugins `stream`, `stream_management`, `management`), Valkey, MinIO, Mailpit, `grafana/otel-lgtm` e Traefik, com healthchecks; verificar com `pnpm env:up infra` que tudo fica `healthy`
- [x] 2.2 Criar o script de init do Postgres que gera, para cada serviço do catálogo, o database, `<svc>_app` (DML) e `<svc>_migrator` (DDL) com `REVOKE CONNECT FROM PUBLIC`; verificar por teste que o usuário do OMS não conecta no database do ledger e que `<svc>_app` não executa `CREATE TABLE`
- [x] 2.3 Configurar Traefik com certificados `mkcert` (`api.`, `ws.`, `bank.`, `kyc.`, `mail.` em `*.broker.localhost`) e redirecionamento HTTP→HTTPS; verificar que `curl http://api.broker.localhost` é redirecionado
- [x] 2.4 Criar o `Dockerfile` multi-stage parametrizado por serviço (`pnpm deploy --filter`, `node:24-slim`, usuário não-root) e o padrão de serviço one-shot de migração no compose; verificar com um serviço de exemplo que a imagem roda e a migração precede o serviço
- [x] 2.5 Definir os perfis `infra`, `core` e `full`, Docker secrets em `infra/secrets/` (fora do git) e limites de memória; criar os scripts `pnpm env:up|down|logs|seed`; verificar que `pnpm env:up core` sobe só o perfil core
- [x] 2.6 Configurar o MinIO com buckets `documents`, `reports`, `brapi-raw` e `audit-anchors` (object lock) e o Valkey com persistência desligada; verificar que um objeto em `audit-anchors` não pode ser sobrescrito

## 3. Fase 0 — Domínio compartilhado (domain-kernel, ids, clock, calendar)

- [x] 3.1 Implementar `Money`, `Price`, `Quantity` (bigint), `Percentage` e operações com `decimal.js` e arredondamento explícito (`HALF_UP`, truncamento, direcional); verificar com testes de propriedade que 0,1 + 0,2 = 0,3 e que construir a partir de `number` é recusado (ADR-0004)
- [x] 3.2 Implementar o rateio pelo maior resto com resíduo para o maior valor e desempate pelo menor ID; verificar com fast-check que Σ partes = total e com o cenário FEE-010
- [x] 3.3 Implementar `TaxId` (módulo 11, sequências repetidas, máscara `***.456.789-**`) e o gerador de CPFs válidos por penúltimo dígito em `packages/testing`; verificar os casos `TAX_ID_INVALID`
- [x] 3.4 Implementar `packages/ids` (UUID v7, número de conta `NNNNNNN-D`, número de nota, protocolo); verificar a ordenação temporal e o DV da conta (RN-ACC-001, RN-PAD-060)
- [x] 3.5 Implementar `packages/clock` com os modos `REAL`, `ACCELERATED` e `VIRTUAL` (`advance_to`) e `BusinessDate` em `America/Sao_Paulo`; verificar a virada de dia UTC→BRT e o avanço virtual (RN-CLK-001..004)
- [x] 3.6 Implementar `packages/calendar` (`is_business_day`, `next/previous_business_day`, `business_days_between`, `session_schedule` com vigência) e a semente do calendário B3 de 2026–2027; verificar o cenário CAL-001 (Carnaval, Corpus Christi, fim de ano)

## 4. Fase 0 — Persistência

- [x] 4.1 Implementar `packages/persistence` com Kysely + `pg`, conversão `numeric`↔`Decimal`, helper de transação e o migrador one-shot com o usuário de migração; verificar com Testcontainers uma migração e uma transação com rollback
- [x] 4.2 Criar as migrações-base reutilizáveis (`outbox_event`, `processed_event`, `consumer_offset`, `idempotency_record`, `saga_instance`, `dead_letter`, `blocked_key`, `parked_message`) e o helper de tabela append-only (grant sem UPDATE/DELETE + gatilho); verificar que um UPDATE numa tabela append-only falha (RN-DB §3, §4)
- [x] 4.3 Implementar a criptografia de campo AES-256-GCM com envelope encryption e o hash HMAC para busca; verificar com teste o round-trip e que o valor gravado está cifrado (RN-DB-031)
- [x] 4.4 Implementar a eleição de líder por advisory lock com heartbeat; verificar com dois processos que só um fica líder e que o outro assume quando o primeiro morre (RN-ENV-021)

## 5. Fase 0 — Mensageria (RabbitMQ streams)

- [x] 5.1 Spike: com `rabbitmq-stream-js-client`, criar um super stream de 3 partições, publicar por chave e consumir com Single Active Consumer em duas instâncias; verificar a ordem por chave, o failover e a releitura por offset. Registrar o resultado em `docs/adr/0001-rabbitmq-streams.md`
- [x] 5.2 Definir o envelope padrão em TypeBox e o `EventPublisher` (validação de esquema, limite de 256 KB, bloqueio de dados pessoais por lista de campos); verificar que um payload de 300 KB é recusado no produtor (RN-MSG-B §4, RN-MSG-B-013/014)
- [x] 5.3 Implementar o outbox relay (LISTEN/NOTIFY + polling, `SKIP LOCKED`, série por `partition_key`, confirmação do broker, limpeza de 7 dias); verificar que matar o relay entre publicar e marcar não gera efeito duplicado (ADR-0008)
- [x] 5.4 Implementar o `EventConsumer` com SAC, offset e inbox na transação do efeito, rejeição de `environment` diferente e tolerant reader; verificar a idempotência com evento duplicado e a retomada pelo offset salvo (RN-MSG-B-030..032)
- [x] 5.5 Implementar as retentativas locais com backoff, as filas quorum `retry.1m|10m|1h` com TTL/DLX e a DLQ por serviço; verificar a sequência completa com erro transitório forçado e o envio direto para a DLQ em erro de esquema (RN-MSG-B-033/034)
- [x] 5.6 Implementar o bloqueio por chave (`blocked_key`, `parked_message`) com flag por consumidor (ordenado ou não); verificar que a chave A fica retida enquanto a B segue e que a liberação reprocessa em ordem (RN-MSG-B-035)
- [x] 5.7 Implementar a ferramenta de DLQ (CLI + API administrativa: listar, inspecionar, reprocessar, descartar com justificativa auditada); verificar o reprocessamento que desbloqueia a chave (RN-MSG-B-036)
- [x] 5.8 Implementar o publicador e o consumidor de filas de jobs (quorum, ack manual, prefetch); verificar a reentrega quando o worker morre sem ack

## 6. Fase 0 — Service kit

- [x] 6.1 Implementar o bootstrap Express 5 com config validada por TypeBox (falha rápida), leitura de Docker secrets, encerramento gracioso e `/health/live`, `/health/ready`, `/info`; verificar que a falta de uma variável encerra o processo com mensagem clara (RN-BE-061, RN-OBS §5)
- [x] 6.2 Implementar os middlewares de correlação, contexto de execução, validação por esquema, Problem Details (RFC 9457) e conversão de erros técnicos; verificar as respostas `400`, `422` e `503` com `correlationId` (RN-BE-011, RN-BE-030..032)
- [x] 6.3 Implementar o middleware de idempotência (`Idempotency-Key`, hash do corpo, 24 h, Valkey + banco) e a concorrência otimista com `If-Match`/`ETag`; verificar a repetição (mesma resposta) e o reuso com outro corpo (`409 IDEMPOTENCY_KEY_REUSED`)
- [x] 6.4 Implementar logs `pino` JSON com campos mínimos, `wall_clock_at` e redact de campos sensíveis; verificar que `password`, `token` e `taxId` saem mascarados (RN-BE-050/051)
- [x] 6.5 Integrar o OpenTelemetry (HTTP, pg, amqp, undici e spans manuais nos consumidores via `traceparent` do envelope) e métricas RED; verificar no Grafana um trace HTTP→evento→consumidor (RN-OBS §4)
- [x] 6.6 Implementar a autenticação de usuário (JWT/JWKS) e de serviço (client credentials com escopos), o helper de autorização por propriedade (`404` para recurso alheio) e o cliente RPC (`undici`, timeout, `opossum`, retentativa só idempotente); verificar o disjuntor abrindo com a dependência lenta (RN-ARQ-002, RN-AUTHZ-002)
- [x] 6.7 Implementar paginação por cursor (limite padrão 50, máximo 200), filtros e ordenação permitida, e um helper de saga orquestrada (`saga_instance`, timeouts, retomada); verificar a retomada da saga após reinício (RN-API-020..023, RN-PAD-030/031)
- [x] 6.8 Implementar as feature flags por ambiente com sobrescrita por conta; verificar uma rota bloqueada com a flag desligada (RN-PAD-072)

## 7. Fase 0 — Contratos, cenários e testes compartilhados

- [x] 7.1 Criar `contracts/` com a geração de JSON Schema, AsyncAPI 3 e OpenAPI 3.1 a partir do TypeBox e o script de compatibilidade contra o `main`; verificar que remover um campo obrigatório sem subir a versão reprova o script (RN-MSG-B-020..023)
- [x] 7.2 Criar `packages/testing` com builders por agregado, relógio virtual, Testcontainers (Postgres, RabbitMQ) e utilitários de E2E; verificar com um teste de integração de exemplo (RN-QA-020/021)
- [x] 7.3 Criar o formato YAML de cenários em `scenarios/` e o runner de golden master (entradas, saídas esperadas, semente); verificar com um cenário trivial passando e outro falhando com diff legível

## 8. Fase 0 — Simuladores externos

- [x] 8.1 Implementar a biblioteca de webhooks dos simuladores (HMAC-SHA256 `timestamp.corpo`, `X-Signature`/`X-Timestamp`, retentativa 1 s→1 h) e o verificador do lado receptor (desvio > 5 min recusado); verificar a assinatura inválida e o reenvio até `2xx` (RN-SIM-003/004)
- [x] 8.2 Implementar o `pix-simulator` (contas, cobrança, pagamento, envio, consulta de chave, devolução, consulta de transação, `end_to_end_id` com prefixo de simulação, latência e erros configuráveis); verificar com testes de componente cada operação (Sistemas simulados §2)
- [x] 8.3 Adicionar ao `pix-simulator` os cenários forçáveis (pagamento duplicado, webhook atrasado, chave inexistente, indisponibilidade de 10 min, saldo insuficiente) e a UI de inspeção; verificar o webhook duplicado (RN-PIXS-003, RN-SIM-005)
- [x] 8.4 Implementar o `kyc-simulator` (submissão `202` com `check_id`, regras pelo penúltimo dígito, webhook por verificação, leitura de documentos só por URL assinada, UI de inspeção); verificar os dígitos 0–6, 7, 8 e 9 (RN-ONB §5.2, RN-KYCS-001)
- [x] 8.5 Implementar o `message-sink` (SMS e push registrados com UI) e integrar o Mailpit para e-mail com lista de permissão; verificar que um e-mail fora da lista fica só na caixa de captura (RN-MSG-001..003)

## 9. Fase 0 — Pipeline de CI

- [x] 9.1 Criar o workflow do GitHub Actions com Turborepo (afetados): lint, typecheck, unitários com cobertura, integração (serviços Docker), contrato e compatibilidade de esquemas; verificar um PR de teste passando e outro reprovado por lint
- [x] 9.2 Adicionar Semgrep, `osv-scanner`, `gitleaks`, build de imagens com SBOM (`syft`) e assinatura (`cosign`); verificar que um segredo de teste commitado reprova o pipeline (RN-CICD §2)
- [x] 9.3 Adicionar a convenção de commits e o changelog por serviço, além do versionamento semver exposto no `/info`; verificar o `/info` do serviço de exemplo (RN-CICD-020/021)

## 10. Fase 0 — Critério de pronto

- [x] 10.1 Criar um serviço de exemplo (`apps/example-service`, criado no grupo 6) que publica por outbox e consome com inbox, com trace de ponta a ponta; verificar com teste E2E e no Grafana
- [x] 10.2 Escrever `docs/primeiros-passos.md` (pré-requisitos, `mkcert`, `pnpm env:up`, URLs das UIs) e verificar seguindo o guia numa clone limpa

## 11. Fase 1 — scheduler-service

- [x] 11.1 Implementar `routine_definition`/`routine_execution`, o disparo de `routine.triggered` pela tabela de rotinas e pelo calendário, e a idempotência por `(routine_name, business_date)`; verificar que o feriado não dispara e que o disparo duplicado não duplica (RN-ROT-001)
- [x] 11.2 Implementar as dependências por `routine.completed` e o catch-up em ordem de datas; verificar com o relógio virtual um dia perdido (RN-ROT-002/003)
- [x] 11.3 Implementar a publicação de `clock.ticked` nos modos `ACCELERATED`/`VIRTUAL`, o comando `advance_to` (só em VIRTUAL/sandbox) e a liderança por lease; verificar o failover sem disparo duplicado (RN-CLK-003)

## 12. Fase 1 — audit-service

- [ ] 12.1 Implementar `audit_record` append-only com `seq` e hash encadeado sobre o conteúdo canônico, consumindo eventos `auditable` e `audit.*`; verificar que a adulteração manual é detectada pela verificação (RN-AUD-001, RN-AUD-BO-002)
- [ ] 12.2 Implementar a verificação diária da cadeia com alerta crítico e a ancoragem do hash diário no bucket com object lock; verificar que a âncora não pode ser sobrescrita (RN-AUD-002)
- [ ] 12.3 Implementar a consulta (ator, ação, recurso, período) restrita a `BO_AUDITOR`/`BO_ADMIN`, auditando a própria consulta; verificar o `403` para `BO_FINANCE` (RN-AUD-005)

## 13. Fase 1 — identity-service

- [ ] 13.1 Implementar o modelo (`user`, `credential`, `mfa_factor`, `session`, `device`, `refresh_token`, `role`, `permission`, `login_attempt`) com dois realms e o registro de cliente com política de senha (argon2id, lista de vazadas, sem CPF/nome/e-mail); verificar a recusa de senha com CPF (RN-AUTH-001)
- [ ] 13.2 Implementar o Authorization Code + PKCE, o access token ES256 (claims completos), a JWKS rotacionável e o refresh opaco com rotação e detecção de reuso; verificar a revogação da família no reuso (Autenticação §4)
- [ ] 13.3 Implementar o bloqueio por tentativas (atraso progressivo, bloqueio de 30 min, e-mail) com resposta indistinguível para e-mail inexistente; verificar a 10ª falha (RN-AUTH-002)
- [ ] 13.4 Implementar TOTP, WebAuthn e OTP SMS simulado, sessões e dispositivos (listar, revogar, `new_device_detected`), inatividade por canal e lista de revogação no Valkey; verificar a revogação refletindo no gateway (RN-AUTH-003, RN-AUTH-012/013)
- [ ] 13.5 Implementar a assinatura eletrônica (segredo próprio, token com escopo e validade, bloqueios 3/6), o step-up por `amr` e a recuperação de acesso (link de 15 min + segundo fator, revoga sessões, bloqueia assinatura por 24 h); verificar escopo errado → `TRADING_SIGNATURE_REQUIRED` (RN-SIG-*, RN-AUTHZ-003, RN-AUTH-004)
- [ ] 13.6 Implementar o RBAC do backoffice com segregação (`BO_AUDITOR` exclusivo), MFA forte obrigatório no realm `backoffice`, client credentials para serviços e o consumidor de `account.status_changed` (BLOCKED revoga assinaturas); verificar a segregação e a revogação (RN-BO-001/002, RN-AUTH-014)

## 14. Fase 1 — customer-service

- [ ] 14.1 Implementar `onboarding_application` com a máquina de estados, as etapas como rascunho, as validações cadastrais e a unicidade por CPF (hash com chave); verificar `UNDERAGE`, `TAX_ID_ALREADY_REGISTERED` e a retomada (RN-ONB-001/004)
- [ ] 14.2 Implementar o upload de documentos por URL pré-assinada do MinIO com verificação de tipo pelo conteúdo, tamanho e resolução; verificar `DOCUMENT_INVALID_FORMAT` para 12 MB
- [ ] 14.3 Implementar o adaptador ACL do KYC (submissão, webhook assinado, `kyc_check` com payload bruto, idempotência por `check_id`) e as regras de decisão (FACE_MATCH, PEP e residência fiscal → revisão manual); verificar os quatro cenários de KYC (RN-ONB-010/011/020..022)
- [ ] 14.4 Implementar a saga de abertura (aprovação → conta `NNNNNNN-D` → `customer.created`/`account.opened`) com retomada após reinício; verificar a criação única da conta após reinício no meio
- [ ] 14.5 Implementar o suitability (questionário versionado, pesos, faixas parametrizáveis, validade de 24 meses, `suitability.expiring/expired`) e os termos (aceite com hash, nova versão bloqueia operações); verificar a pontuação 32 → `AGGRESSIVE` e `TERMS_PENDING` (RN-SUI-*, RN-TER-*)
- [ ] 14.6 Implementar o status da conta com a matriz de permissões, `account.status_changed`, o consumidor de saldo devedor e o encerramento com lista de pendências; verificar `RESTRICTED` por `NEGATIVE_BALANCE` e o retorno a `ACTIVE` (RN-ACC-010..012, RN-DEV-002/005)
- [ ] 14.7 Implementar as contas de saque (até 3, titularidade via simulador, assinatura, carência de 24 h) e a manutenção cadastral (OTP duplo, revisão manual de nome/documento, histórico, vencimento em 24 meses); verificar a chave de terceiro → `BANK_ACCOUNT_NOT_ALLOWED` (RN-ACC-020/021, RN-CAD-*)
- [ ] 14.8 Implementar a expiração do onboarding (30 dias) e a criação da conta no Banco Simulado ao abrir a conta; verificar com o relógio virtual (RN-ONB-002)

## 15. Fase 1 — ledger-service

- [ ] 15.1 Implementar `ledger_account`, `journal` e `ledger_entry` append-only, a validação de soma zero, a idempotência por `idempotency_key`, a sequência por conta e a convenção de sinal num único módulo; verificar com testes de propriedade que Σ = 0 sempre (RN-LED-001..007, INV-01)
- [ ] 15.2 Criar as contas da casa por migração e as contas do cliente ao consumir `account.opened`; verificar a idempotência da criação (RN-LED-010/011)
- [ ] 15.3 Implementar os saldos (`settled`, `projected(Dn)`, `total`, `withdrawable`) com `as_of` e os eventos `ledger.journal_posted`/`balance_changed`; verificar o cenário LED-001
- [ ] 15.4 Implementar o depósito (intenção, cobrança no simulador, webhook assinado, validações de titularidade, valor e expiração, devolução, crédito `SETTLED`, estados); verificar o depósito de terceiro, o pagamento após expiração e o webhook duplicado (RN-DEP-*)
- [ ] 15.5 Implementar a saga de saque com a porta `RiskHoldPort` (na Fase 1, um adaptador provisório local que calcula o sacável no próprio ledger), limites diário e noturno, revisão acima de R$ 50 mil, retentativas e estados; verificar o limite noturno e a falha definitiva liberando o hold (RN-SAQ-*)
- [ ] 15.6 Implementar o extrato (filtros, cursor, saldo após cada lançamento, futuros agrupados) e a reconciliação PIX diária; verificar com dados de exemplo (RN-EXT-001/002/004, RN-PIXS-002)

## 16. Fase 1 — reference-data-service

- [ ] 16.1 Implementar `instrument` com padrões por tipo, fracionário derivado, status e o consumidor de `market_data.catalog_synced`; verificar o padrão de FII e a busca por `PETR4F` (Ativos §2–§3)
- [ ] 16.2 Implementar o universo negociável (limite configurável, inclusão/retirada via aprovação com recusa se houver ordens abertas) e `instrument.tradability_changed`; verificar a recusa do 21º instrumento (RN-INS-011..014)
- [ ] 16.3 Implementar `instrument_symbol_history`, a busca por ticker antigo e as tarefas de renomeação; verificar o aviso "Ticker alterado" (RN-INS-030..033)
- [ ] 16.4 Implementar `instrument_trading_rules` com vigência (global + sobrescrita), `trading_calendar` e `session_schedule` com vigência, o alerta de 60 dias e `calendar.updated`; verificar a vigência futura e o sandbox sempre útil (RN-CAL-*, RN-SBX-002)

## 17. Fase 1 — market-data-service (externo e referência)

- [ ] 17.1 Definir a porta `MarketDataProvider` e os adaptadores `fixture`, `replay` e `brapi` (ACL, normalização para `external_quote`), com fixtures gravadas cobrindo sucesso, `changed=true`, nulos, `400/401/403/404/429/5xx` e corpo inválido; verificar o mapeamento por teste de contrato (RN-BRP-002/003, RN-QA-022)
- [ ] 17.2 Implementar a fila única com líder (lease), concorrência 1, intervalo mínimo, prioridades P0–P5, coalescência e disjuntor; verificar a coalescência de 10 pedidos e o disjuntor após 5 falhas (RN-BRP-040..043, RN-BRP-080)
- [ ] 17.3 Implementar o controlador de orçamento (endpoint de uso, contador local, reserva de 20%, níveis com evento) e o agendamento adaptativo; verificar `EXHAUSTED` no `429` por cota e nenhuma requisição no fim de semana (RN-BRP-030..035, RN-BRP-050..053)
- [ ] 17.4 Implementar `external_quote_history`, o descarte fora de ordem, a quarentena de saltos, a defasagem e `instrument_stale`, o cache no Valkey, o corpo bruto no MinIO e o snapshot pós-fechamento; verificar a quarentena de 8% e o descarte fora de ordem (RN-BRP-060..072)
- [ ] 17.5 Implementar o catálogo diário, o histórico diário (`external_daily_candle`) e o Ibovespa externo; verificar `market_data.catalog_synced` com as fixtures
- [ ] 17.6 Implementar o preço de referência (glide linear, ruído com reversão à média semeado, só em `CONTINUOUS`, override manual, desligável) com `reference_price_updated` e `origin`; verificar a reprodutibilidade pela semente (Brapi §8, RN-SYN-001..004/006)
- [ ] 17.7 Implementar a segurança do token (segredo, sem log, dois tokens na rotação) e o job semanal de verificação de esquema (desligado por padrão no local); verificar que o log não contém `Authorization` (RN-BRP-090..095, RN-BRP-100)

## 18. Fase 1 — notification-service

- [ ] 18.1 Implementar o catálogo, os templates versionados pt-BR, as preferências, a idempotência `(event_id, code, channel)` e a central in-app (listar, marcar lida, 90 dias); verificar a formatação de moeda e a idempotência (RN-NOT-G-001..004/008)
- [ ] 18.2 Implementar a entrega por canal (Mailpit, message-sink para SMS/push) com retentativa, horário de silêncio, agrupamento de parciais e "ocultar valores"; verificar que a crítica ignora o silêncio (RN-NOT-G-003/005..007)
- [ ] 18.3 Ligar os consumidores dos eventos da Fase 1 (depósito, saque, onboarding, segurança, status da conta, saldo devedor, suitability); verificar `DEPOSIT_CREDITED` na caixa de captura

## 19. Fase 1 — api-gateway e bff-web

- [ ] 19.1 Implementar o `api-gateway` (JWKS, revogação, rate limit no Valkey, CORS, limite de corpo, headers de segurança, correlação, `426`, roteamento para BFFs); verificar o `429` no 11º login e o `401` com token revogado (RN-API §3, §6, §7)
- [ ] 19.2 Implementar o `bff-web` como token handler (PKCE, cookies `HttpOnly`/`SameSite=Strict`, anti-CSRF), as rotas `/v1/me` com conta do token, read-your-writes e `asOf`; verificar o `403` sem token anti-CSRF (RN-AUTH-010, RN-API-043, RN-PAD-010/011)
- [ ] 19.3 Expor no `bff-web` as rotas da Fase 1 (auth, onboarding, perfil, suitability, saldos, extrato, depósitos, saques, contas de saque, instrumentos, cotação externa, notificações) seguindo `Contratos §1–§4` e emitir eventos de auditoria; verificar com testes de contrato

## 20. Fase 1 — Critério de pronto

- [ ] 20.1 Teste E2E: cadastro → KYC aprovado → conta ativa → depósito PIX → cotação externa com defasagem sinalizada → saque, terminando com INV-01 verificado; verificar no CI com o compose `core`
- [ ] 20.2 Atualizar as sementes (`pnpm env:seed`) com usuários por cenário de KYC, universo inicial e histórico por replay; verificar a idempotência rodando duas vezes (RN-ENV-031)

## 21. Fase 2 — trading-session-service

- [ ] 21.1 Implementar `trading_day`, `market_phase_state` e `instrument_phase_state` com a fase efetiva mais restritiva, a grade por `session_schedule` acionada por rotinas, `session.phase_changed` e o comando `PhaseChange` ao Motor; verificar um dia completo com o relógio virtual (RN-SES-001/002)
- [ ] 21.2 Implementar os leilões programados com prorrogação e política, as suspensões (manual, defasagem, evento corporativo, falha técnica, `ENGINE_RECOVERY`) com retomada por leilão e `cancel_all_on_halt`; verificar a prorrogação por túnel estático (RN-AUC-001..003, RN-HLT-*)
- [ ] 21.3 Implementar o circuit breaker (níveis, uma vez por pregão, última meia hora, manual e sandbox) e o preço de fechamento por precedência com alerta de divergência; verificar o nível 1 e a ausência de disparo às 16:40 (RN-CB-*, RN-FCH-*)

## 22. Fase 2 — matching-engine

- [ ] 22.1 Implementar o livro em memória (níveis ordenados, FIFO por nível, índice por ordem, `MAIN`/`ODD_LOT`), a prioridade preço-tempo e o preço do negócio; verificar os cenários ME-001, ME-002, ME-005 e ME-014 no runner
- [ ] 22.2 Implementar `MARKET` com proteção, `IOC`, `FOK` com simulação prévia, STP (três políticas) e iceberg; verificar ME-003, ME-004, ME-006 e ME-007
- [ ] 22.3 Implementar os túneis (rejeição, estático, dinâmico), o leilão por volatilidade, o acúmulo e o preço teórico com os 5 critérios, a conclusão e o encerramento aleatório semeado; verificar ME-008, ME-009 (cada critério), ME-010, ME-011 e ME-013
- [ ] 22.4 Implementar o sequenciador por partição (SAC + lease), `engine_journal` com group commit antes do processamento, `engine_output` com `engine_seq` e o relay para `engine.events`; verificar que uma queda após o journal não perde a entrada (RN-ME-003/004, RNF-031)
- [ ] 22.5 Implementar snapshots (10 mil entradas ou 5 min), a recuperação com replay idêntico, o `HALTED` durante a recuperação, o EOD com reapresentação de GTC/GTD e a API administrativa; verificar ME-012 e o tempo de recuperação < 30 s
- [ ] 22.6 Criar um benchmark do matching em memória (p99 e vazão por livro) e registrar a linha de base no README do Motor (RNF-002)

## 23. Fase 2 — market-maker-service

- [ ] 23.1 Implementar o cálculo das cotações (meio-spread, passo, inclinação, níveis, quantidades, arredondamento direcional) e as garantias de forma e de inventário; verificar com testes de propriedade `bid_1 < ask_1` e preços dentro do túnel (Motor §6.3, RN-SMM-001/002)
- [ ] 23.2 Implementar a recotação (limiar, nível executado, fase, manutenção) por cancelar + nova ordem, a varredura limitada, o comportamento por fase e o alargamento por defasagem; verificar o cancelamento total em `HALTED` e o spread ×8 após 3 h (RN-SMM-010..012/032)
- [ ] 23.3 Implementar a conta `MARKET_MAKER`, o estoque inicial por emissão simulada (custódia do FMS, criada na Fase 3 como movimento retroativo pelo evento de ativação), o kill switch e as métricas `smm.*`; verificar o kill switch global (RN-SMM-020..022/030/031)

## 24. Fase 2 — risk-service (à vista)

- [ ] 24.1 Implementar a projeção em memória por partição (P2 do ledger, U dos negócios do Motor casados por `trade_id`, H, posições, preços) com snapshot e offsets e `readiness` só após a reconstrução; verificar que o lançamento do ledger move o valor de U para P2 sem alterar o BP (ADR-0003)
- [ ] 24.2 Implementar os holds (`ORDER_CASH`, `ORDER_POSITION`, `WITHDRAWAL`) persistidos antes da resposta, a redução proporcional por execução, a liberação por cancelamento/expiração e a reconciliação de órfãos a cada 5 min; verificar a execução parcial abaixo do limite (RN-HLD-001..004/007)
- [ ] 24.3 Implementar o pré-trade síncrono (sequência §11, `BP_cash`, `Q_disp`, venda coberta, limites de ordens abertas, resposta com valores) com serialização por conta, além de `CreateHold`/`ReleaseHold` para saques, substituindo o adaptador provisório do ledger; verificar RSK-001 e RSK-030 (compra e saque simultâneos)
- [ ] 24.4 Medir o p99 do pré-trade sob carga local e registrar no README (RNF-003)

## 25. Fase 2 — oms-service (básico)

- [ ] 25.1 Implementar o agregado `Order` com a máquina de estados completa, `order_event` imutável e os eventos de domínio + `order.updated`; verificar ORD-001..020 (todas as transições válidas e um conjunto de inválidas)
- [ ] 25.2 Implementar as validações 1–11 em ordem determinística (conta, termos e suitability por projeção local, instrumento, fase, campos, lote, tick, túnel, notional, rate limit) e a rejeição registrada; verificar a primeira falha prevalecendo (Ordens §9, RN-VAL-001)
- [ ] 25.3 Implementar o envio (`client_order_id` idempotente, pré-trade com 200 ms e fail closed, `PENDING_NEW`, comando ao Motor pela outbox, `202`); verificar `RISK_UNAVAILABLE` com o Risco parado (RN-FLX-001/002)
- [ ] 25.4 Implementar a aplicação das saídas do Motor (execuções em qualquer estado não terminal, deduplicação por `engine_seq`, detecção de lacuna e pedido de replay), `order_fill` e INV-04; verificar a execução durante `PENDING_CANCEL` (RN-ORD-022/023)
- [ ] 25.5 Implementar `MARKET` com proteção, as validades `DAY`/`IOC`/`FOK`, as ordens agendadas com envio na pré-abertura, a divisão lote/fracionário com ordem-mãe, alteração e cancelamento (inclusive em massa e enfileirado em `PENDING_NEW`), as regras de `CLOSING_CALL`/`HALTED` e o EOD; verificar ORD-030 e a ordem enviada às 20:00 (RN-ORD-001..011, RN-SES-003/004, RN-ALT-*, RN-CAN-*, RN-CMP-*)
- [ ] 25.6 Implementar as consultas (filtros, cursor, detalhe com histórico, execuções) e a simulação de custos da boleta usando a estimativa do Clearing (na Fase 2, um adaptador com a tabela de referência); verificar a estimativa de R$ 1,15 (RN-FEE-040/041)

## 26. Fase 2 — market-data-service (dados internos)

- [ ] 26.1 Implementar a cotação L1 interna, o book L2/L3 anônimo, `trade_tick` e o estado do pregão a partir de `engine.*`, com deduplicação por `engine_seq`; verificar `market_data.trade_printed` após `engine.trade_executed`
- [ ] 26.2 Implementar os candles internos 1m–1M sem candles vazios, a costura do diário externo/interno com indicação de fonte, a correção por trade bust e a valorização por precedência; verificar a ausência de candle sem negócio (RN-MD-002/010..013)
- [ ] 26.3 Expor as rotas de mercado (cotação interna + externa, book, negócios, candles com `adjusted`, sessão) com o rótulo de fonte; verificar por teste de contrato (RN-MD-001, Contratos §4)

## 27. Fase 2 — realtime-gateway

- [ ] 27.1 Implementar o servidor WebSocket com `auth` na primeira mensagem (5 s), `auth_expiring`/`AUTH_EXPIRED`, heartbeat 15/45 s e os limites de assinaturas e conexões; verificar o encerramento sem `auth` (RN-RT-001..006)
- [ ] 27.2 Implementar o envelope com `seq` por (canal, chave), o cache de snapshots no Valkey, `resync`, a autorização por canal (`key = "me"`, `book_l3` só desktop) e o encerramento por `BLOCKED`; verificar a assinatura de conta alheia recusada (RN-RT-010/020/030, RN-AUTH-014)
- [ ] 27.3 Implementar o fan-out a partir do barramento com conflação/throttle por canal, a entrega completa e em ordem dos canais privados, o backpressure (`resync_required`) e as métricas; verificar 20 cotações/s → no máximo 4 msg/s (RN-RT-021/032/033)

## 28. Fase 2 — Critério de pronto

- [ ] 28.1 Incluir as rotas de ordens, mercado e sessão no `bff-web` e as rotas do `realtime-gateway` no Traefik; verificar por testes de contrato
- [ ] 28.2 Teste E2E: o cliente compra e vende contra o FMS e contra outro cliente, recebendo as atualizações pelo tempo real, terminando com INV-03 e INV-04 verificados; verificar no CI
- [ ] 28.3 Executar todos os cenários golden master ME-001..ME-014 no pipeline do Motor; verificar que todos passam

## 29. Fase 3 — clearing-service

- [ ] 29.1 Implementar a alocação idempotente por `(trade_id, side)`, a ponta do FMS sem custos e `clearing.trade_allocated` por `account_id`; verificar o negócio reentregue (RN-CLR-001..004)
- [ ] 29.2 Implementar `fee_schedule` com vigência (modelos de corretagem, faixas de day trade, IRRF) alterada por aprovação, `fees.schedule_changed` e a API de estimativa (substituindo os adaptadores provisórios do OMS e do Risco); verificar a recusa de vigência no passado (RN-FEE-001..020, RN-HLD-003)
- [ ] 29.3 Implementar a classificação day trade/swing (provisória em tempo real e final no fechamento) e `clearing.daytrade_classified`; verificar CLR-001 (RN-CLR-010..013)
- [ ] 29.4 Implementar o cálculo da nota por modalidade com `HALF_UP` por componente, o rateio por notional com resíduo determinístico, a nota por conta e pregão (rotina 17:10, numeração, conteúdo estilo SINACOR) e `clearing.note_generated`; verificar FEE-001 e FEE-010 (RN-NTC-*, RN-FEE-030/031)
- [ ] 29.5 Implementar a reversão por trade bust antes das notas, a nota de retificação `CORRECTION` e a saga de liquidação D+2 (custódia + ledger, entrega contra pagamento com compensação), além da recompra compulsória com multa; verificar a falha no lote financeiro revertendo os ativos (RN-LQA-*, RN-BST-002)

## 30. Fase 3 — custody-service

- [ ] 30.1 Implementar `position` e `custody_movement` append-only em partidas dobradas com as contas do sistema, os movimentos por alocação e por liquidação e `custody.*`; verificar a conservação por teste de propriedade (RN-CST-*, INV-02)
- [ ] 30.2 Implementar o PM pela regra fiscal (compra, venda, zeragem, short, inversão, exclusão de day trade, provisório → efetivo na nota) com 8 casas; verificar PM-001..010 e FEE-001 (PM 38,5115) (RN-PM-*)
- [ ] 30.3 Implementar a participação na saga de liquidação (atômica por lote, reversão por compensação), o estoque inicial do FMS e a transferência de custódia (aprovação, automática no sandbox); verificar a compensação e a entrada no sandbox (RN-LQA-002, RN-SMM-020, RN-TRF-*)
- [ ] 30.4 Implementar a carteira valorizada (read model por eventos de preço), o patrimônio, `portfolio_daily_snapshot`, o TWR por período com benchmark, a distribuição e o extrato de custódia; verificar o depósito sem efeito na rentabilidade (RN-RNT-*, RN-EXC-001)
- [ ] 30.5 Integrar a custódia ao Risco (`custody.position_changed` na projeção) e ao `bff-web` (rotas de carteira e posições); verificar `Q_disp` após a liquidação

## 31. Fase 3 — engagement-service

- [ ] 31.1 Implementar as watchlists (20 listas × 100, "Favoritos" na abertura, ordem e colunas sincronizadas, "somente consulta") e `watchlist.changed`; verificar a lista padrão criada no `account.opened` (RN-WL-*)
- [ ] 31.2 Implementar os alertas de preço (condições, fonte, recorrência, expiração, limite 50, avaliação por cruzamento com throttle, escolha na criação) e `alert.*`; verificar o cruzamento 39,90 → 40,10 (RN-ALR-*)
- [ ] 31.3 Ligar as notificações de ordens, alertas e notas no `notification-service`; verificar `PRICE_ALERT` e `BROKERAGE_NOTE_AVAILABLE` na central

## 32. Fase 3 — reporting-service

- [ ] 32.1 Implementar `report_job` com fila de jobs, workers, estados, limites (5 jobs, 5 anos), links pré-assinados de 15 min só para o dono, `report.*` e notificação; verificar o link recusado para outro usuário (RN-REL-003/004)
- [ ] 32.2 Implementar o gerador PDF (marca em todas as páginas, `document_id`, SHA-256), o CSV pt-BR/técnico e o versionamento imutável com `supersedes_document_id`; verificar o hash impresso igual ao do arquivo (RN-REL-001/002/005)
- [ ] 32.3 Implementar os read models e os documentos da fase (nota, extratos financeiro e de custódia, posição, histórico de ordens, rentabilidade, comprovantes) e a retenção; verificar a nota em PDF a partir de `clearing.note_generated` (Relatórios §2, RN-REL-006/007)

## 33. Fase 3 — approval-service e bff-backoffice

- [ ] 33.1 Implementar `approval_request` e `approval_policy` (papéis, limites), os estados com `STALE` pela comparação de estado, a proibição de o maker aprovar, a expiração e `approval.*`; verificar o maker aprovando → recusado e o `STALE` (RN-MC-BO-*)
- [ ] 33.2 Implementar no `bff-backoffice` o realm `backoffice`, a restrição de rede, a sessão de 8 h/15 min, a matriz de funções e as rotas `/v1/bo/*` das fases 1–3 (cadastro, financeiro, ajustes, mercado, FMS, sessão, trade bust, clientes 360° mascarado com break-the-glass, aprovações, auditoria, DLQ, sagas presas); verificar o `403` com token de cliente e a auditoria do break-the-glass (Backoffice §3, §5, RN-SUP-*)
- [ ] 33.3 Ligar os consumidores de `approval.request_approved` nos donos (ajuste no ledger, universo e regras no reference-data, tabela de custos no clearing, trade bust no Motor via comando, religar FMS); verificar a execução idempotente pelo `approval_request_id` (RN-MC-BO-004)

## 34. Fase 3 — Critério de pronto

- [ ] 34.1 Teste E2E: uma operação gera nota correta, PM correto e liquida em D+2 com um feriado no meio (relógio virtual), terminando com INV-01 e INV-02 verificados; verificar no CI
- [ ] 34.2 Executar os golden masters LED-010, FEE-001, FEE-010, CLR-001 e PM-001..010; verificar que todos passam

## 35. Fase 4 — OMS avançado

- [ ] 35.1 Implementar as ordens condicionais (`PENDING_TRIGGER`, índice por instrumento/preço reconstruído ao iniciar, disparo só em `CONTINUOUS` pelo livro principal, FIFO, revalidação de risco, `allow_immediate_trigger`, abertura que pula o stop) com reserva na criação; verificar o stop disparado e `RISK_REJECTED_ON_TRIGGER` (RN-STP-*, RN-ORD-004, RN-HLD-005)
- [ ] 35.2 Implementar o trailing stop (valor/percentual, arredondamento conservador, `trailing_step`, `order.trailing_adjusted` com throttle); verificar ORD-050 (RN-TRL-*)
- [ ] 35.3 Implementar OCO (redução pela execução, cancelamento do grupo, `CANCEL_THEN_SEND`, serialização por grupo, `oco.overfill_detected`, hold único) e bracket; verificar ORD-040 e a sobre-execução (RN-OCO-*, RN-BRK-*, RN-HLD-006)
- [ ] 35.4 Implementar o iceberg ponta a ponta, `GTC` (30 dias) e `GTD` (até 90 dias) com reapresentação diária e o cancelamento por evento corporativo; verificar a expiração de GTC com o relógio virtual (RN-ICE-*, RN-ORD-011/012)
- [ ] 35.5 Medir a latência negócio → ordem no Motor do disparo de stop e registrar no README (RNF-004)

## 36. Fase 4 — corporate-actions-service

- [ ] 36.1 Implementar `corporate_action` com o ciclo de vida, a captura via market-data (E4/E5 se o plano permitir, `403` → manual), o cadastro manual com aprovação, a injeção no sandbox e a deduplicação com alerta; verificar o fallback do `403` (RN-CA-001/002)
- [ ] 36.2 Implementar a saga: direitos na data-com (projeção, compras do dia, doadas/tomadas), provisionamento na data-ex, pagamento às 08:30 com truncamento e IR (`corporate_action.paid`), data de pagamento a definir; verificar CA-010 (JCP) (RN-CA-010..024)
- [ ] 36.3 Implementar os eventos em ações (desdobramento, grupamento, bonificação, conversão), as frações (leilão simulado e pagamento) e os efeitos colaterais (suspensão, cancelamento de GTC/GTD, ajuste de `previous_close`/túnel, estoque do FMS, contratos BTC, candles ajustados na leitura); verificar CA-001 (RN-CA-030..056)
- [ ] 36.4 Implementar o calendário de proventos e os recebidos para o cliente, os subscrições informativas e as notificações; verificar o provento futuro com valor estimado (RN-CA-060/070..072)

## 37. Fase 4 — tax-service

- [ ] 37.1 Implementar `tax_rules` com vigência e aprovação, a matriz de compensação e o registro de resultados realizados por categoria, rastreáveis até a nota e o negócio; verificar a venda de FII em `REIT`
- [ ] 37.2 Implementar a apuração mensal (isenção de R$ 20 mil, prejuízos por grupo, compensação proporcional, IRRF dedutível com saldo anual, short no mês da recompra) e a prévia em tempo real; verificar IR-001, IR-002 e IR-004 (RN-IR-*)
- [ ] 37.3 Implementar o DARF simulado (código 6015, vencimento, mínimo R$ 10 acumulado, multa e juros recalculados, código de barras fictício, pagamento com saldo e assinatura, estados) e a retificação com versões; verificar IR-003 e o DARF em atraso (RN-DARF-*)
- [ ] 37.4 Implementar os rendimentos (proventos, aluguel com tabela regressiva) e o relatório anual (bens e direitos, isentos, exclusivos, mês a mês, informe) com PDF/CSV/JSON pelo reporting; verificar bens e direitos em 31/12 (RN-ANU-*)

## 38. Fase 4 — Critério de pronto

- [ ] 38.1 Executar os golden masters ORD-*, CA-* e IR-* e um E2E de um mês completo com relógio virtual (ordens condicionais, provento, apuração e DARF), terminando com as reconciliações; verificar no CI

## 39. Fase 5 — Risco avançado

- [ ] 39.1 Implementar o day trade (habilitação, `margin_enabled`, termo, `BP_daytrade` por tipo, exposição e requisito intradiário, aviso e auto-zeragem, conversão em swing); verificar a auto-zeragem com ordens `SYSTEM` não canceláveis (RN-DT-*)
- [ ] 39.2 Implementar o patrimônio de garantia com haircuts, os requisitos inicial e de manutenção e a venda a descoberto (habilitações, `E_após ≥ R_inicial_após`, sem fracionário, `max_short_interest_qty`); verificar RSK-010 e `SUITABILITY_NOT_ALLOWED` (Risco §6, RN-SHT-*)
- [ ] 39.3 Implementar o monitoramento (gatilhos, throttle de 5 s, estados de margem), a chamada de margem (valor, prazo, bloqueio de aumento de risco, atendimento, vencimento) e as notificações; verificar RSK-020 (RN-MON-001, RN-MC-*)
- [ ] 39.4 Implementar a saga de zeragem compulsória (gatilhos, algoritmo de 6 passos, ordens `MARKET IOC` `SYSTEM`, agendamento fora do contínuo, eventos com o cálculo) e os limites adicionais (exposição × patrimônio declarado, concentração, perda diária); verificar a zeragem até a meta (RN-LIQ-F-*, Risco §10, RN-DEV-004)

## 40. Fase 5 — securities-lending-service

- [ ] 40.1 Implementar as ofertas doadoras, as taxas com spread, o casamento (menor taxa, antiguidade, doador da casa) e a saga de contrato (custódia + holds `BTC_LENT`/`BTC_COLLATERAL`); verificar o contrato aberto refletindo nas duas custódias (RN-BTC-001..005)
- [ ] 40.2 Implementar a remuneração por dia útil com taxa mínima, a liquidação em D+1 com IR regressivo do doador no ledger e o reembolso de proventos/ajuste por eventos; verificar BTC-001 (RN-BTC-010..021)
- [ ] 40.3 Implementar o aluguel automático no fim do pregão, a recompra por `BTC_UNAVAILABLE`, a renovação, a devolução antecipada, o recall (substituição, D+3, recall automático na venda do doado) e `DEFAULTED`; verificar o recall com substituição (RN-BTC-030..043, RN-SHT-004)
- [ ] 40.4 Expor as rotas `/v1/me/btc/*` no `bff-web` e as notificações `BTC_RECALL`; verificar por teste de contrato

## 41. Fase 5 — Critério de pronto

- [ ] 41.1 Executar os golden masters RSK-* e BTC-* e um teste de caos derrubando o líder do Motor durante uma zeragem, terminando sem violação de invariantes; verificar no CI noturno

## 42. Fase 6 — Backend dos canais mobile e desktop

- [ ] 42.1 Implementar o `bff-mobile` (PKCE com app nativo, refresh de 90 dias com biometria, agregações enxutas, registro de token de push) e o `bff-desktop` (sessão de até 8 h, `book_l3`, workspaces e layouts salvos); verificar por testes de contrato e o `book_l3` liberado só no desktop (RN-AUTH-011/012, RN-RT §4)
- [ ] 42.2 Teste E2E: três sessões (web, mobile, desktop) operam a mesma conta ao mesmo tempo com estados consistentes no tempo real e por HTTP; verificar no CI

## 43. Fase 7 — Sandbox e replay

- [ ] 43.1 Criar o perfil sandbox (projeto compose separado, `.env` com `ACCELERATED`, calendário sempre útil, provedor sintético GBM com cenários e semente) e a faixa de ambiente no `/info`; verificar um pregão completo em cerca de 60 min reais e a rejeição de eventos do outro ambiente (RN-SBX-*, RN-SYN-005, RN-PAD-080)
- [ ] 43.2 Implementar os comandos exclusivos do sandbox (avançar relógio, circuit breaker, cenário de mercado, evento corporativo, crédito de teste sem PIX) protegidos por ambiente; verificar que `prod` local recusa esses comandos (RN-SBX-005)
- [ ] 43.3 Implementar o modo replay (relógio virtual + série histórica gravada) para testes e backtests reprodutíveis; verificar duas execuções idênticas

## 44. Fase 7 — LGPD e retenção

- [ ] 44.1 Implementar `privacy_request` (acesso, correção, portabilidade, eliminação, revogação) com exportação assíncrona JSON/PDF e a revogação de biometria apagando a selfie; verificar a portabilidade por link assinado (RN-LGPD-001, LGPD §3)
- [ ] 44.2 Implementar a anonimização após o prazo com `customer.anonymized` e os consumidores em todos os serviços com projeções; verificar que nenhuma projeção mantém nome ou e-mail (RN-LGPD-010/011)
- [ ] 44.3 Implementar as rotinas de retenção por serviço (onboarding, cotações, journal do Motor, outbox, inbox, idempotência, notificações, arquivos, arquivamento frio) com registro na auditoria, e a ferramenta de exportação anonimizada para dev; verificar a remoção de documentos de solicitação reprovada após 30 dias (RN-RET-*)

## 45. Fase 7 — Integridade e observabilidade

- [ ] 45.1 Implementar a rotina das 23:00 de reconciliações INV-01..INV-08 e Motor × OMS × Clearing, publicando para o relatório de reconciliação com alerta crítico; verificar com uma divergência injetada (RN-REC-004, RNF-030)
- [ ] 45.2 Provisionar no Grafana os painéis (executivo, ordens, Motor/mercado, financeiro/reconciliação, risco, integrações, infraestrutura), os SLOs com alertas por taxa de consumo do orçamento de erro e o link de runbook em todo alerta; verificar um alerta disparado apontando o runbook (RN-OBS-001/010)
- [ ] 45.3 Aplicar o particionamento mensal às tabelas de alto volume por migração expand/contract; verificar consultas por período usando *partition pruning* (RN-DB-013)

## 46. Fase 7 — Carga, caos e segurança

- [ ] 46.1 Criar os perfis de carga k6 (abertura, pregão normal com Zipf, pico, fim do dia, liquidação) terminando com reconciliações; registrar a linha de base local de RNF-001..006 em `docs/desempenho.md`
- [ ] 46.2 Criar os testes de caos (Toxiproxy no barramento e nos bancos, derrubar o líder do Motor e do Risco, `429`/`5xx` da brapi, mensagens duplicadas/reordenadas); verificar zero violação de INV-01..08 e a recuperação dentro dos RTOs (RN-RES-020)
- [ ] 46.3 Executar o checklist de revisão de segurança (OWASP API Top 10) em autenticação, autorização, ledger, risco e Motor, os testes de abuso (preço/quantidade negativos, IDOR, saques simultâneos, reuso de idempotency key) e o DAST (OWASP ZAP em contêiner); verificar zero achado crítico aberto (RNF-050)

## 47. Fase 7 — Verificação final

- [ ] 47.1 Rodar o guia de primeiros passos do zero e medir do clone ao primeiro negócio (< 15 min), e o fluxo de conta aprovada até a primeira ordem (< 10 min); registrar em `docs/primeiros-passos.md` (RNF-081, RNF-091)
- [ ] 47.2 Revisar `docs/mapeamento-tecnologico.md`, os READMEs/runbooks de todos os serviços e a lista de divergências entre domínio e implementação; verificar que todo serviço tem runbook e que toda divergência está registrada

## Workflow follow-up

- Antes de aplicar cada fase, abrir uma change específica (ex.: `phase-0-foundations`, `phase-1-accounts-money-prices`) que refina as specs relevantes desta change e detalha as tarefas daquela fase.
- Arquivar esta change de roadmap quando as specs estiverem incorporadas a `openspec/specs/` (ou depois que todas as changes de fase forem arquivadas).
