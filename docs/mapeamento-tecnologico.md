# Mapeamento tecnológico

Atende **RN-BE-082**: diz qual tecnologia implementa cada conceito do `broker-docs`, que é agnóstico de tecnologia. As decisões e alternativas estão em `openspec/changes/implementation-roadmap/design.md` (D1–D23). Se a implementação divergir do domínio, vale o domínio, e o conflito é registrado na seção [Conflitos e simplificações](#conflitos-e-simplificações).

Cada serviço novo acrescenta aqui as tecnologias específicas que usar.

## Plataforma e código

| Conceito                                 | Tecnologia                                                                                                                                                                                                           | Decisão  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Repositório e build                      | Monorepo com pnpm workspaces + Turborepo (build e teste só do que foi afetado)                                                                                                                                       | D1       |
| Runtime e linguagem                      | Node.js 24 LTS, TypeScript `strict` com ESM, `tsc` no build e `tsx` no desenvolvimento                                                                                                                               | D2       |
| Esquemas e validação em runtime          | TypeBox (fonte única) + Ajv                                                                                                                                                                                          | D2       |
| Framework HTTP                           | Express 5 via `@broker/service-kit` (`createService` + `service.route`): contexto, correlação, Problem Details, health/info e encerramento gracioso                                                                  | D2       |
| Arquitetura do serviço                   | Hexagonal (`domain/`, `application/`, `adapters/`, `config/`), garantida por ESLint                                                                                                                                  | D3       |
| Determinismo do domínio                  | Porta `Clock` (`@broker/clock`); ESLint proíbe `Date.now`, `new Date()` e `Math.random`                                                                                                                              | D3, D15  |
| Decimal e objetos de valor               | `decimal.js` (34 dígitos, arredondamento explícito) em `@broker/domain-kernel`                                                                                                                                       | D5       |
| Identificadores                          | UUID v7 próprio (RFC 9562, monotônico) e formatos legíveis em `@broker/ids`                                                                                                                                          | D1       |
| Geradores de teste                       | `@broker/testing`: builders (`defineBuilder`), relógio virtual (`testClock`), PRNG com semente, CPF por penúltimo dígito, Testcontainers e utilitários de E2E                                                        | D20      |
| Relógio do ambiente (REAL/ACCEL/VIRTUAL) | `scheduler-service` é o dono: grava o tempo (`clock_state`), publica `clock.ticked` e aceita `advance_to` (só VIRTUAL); os serviços seguem com `TickedClock` (`@broker/clock`)                                       | D15      |
| Rotinas do dia de negócio                | `scheduler-service`: `routine_definition` (Pregão §8, fases pela grade do calendário), `routine_execution` com PK `(routine_name, business_date)`, dependências por `routine.completed` e catch-up em ordem de datas | D14, D15 |
| Calendário de pregão                     | `@broker/calendar` (funções puras) + cópia local alimentada por `calendar.updated`                                                                                                                                   | D15      |
| Lint e formatação                        | ESLint (flat config, `typescript-eslint`, `eslint-plugin-import-x`) + Prettier                                                                                                                                       | D3       |

## Barramento e mensageria

| Conceito                             | Tecnologia                                                                                                                                                                                                                                   | Decisão |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Barramento de eventos e comandos     | RabbitMQ 4 com **super streams** (partição por `partitionKey`, releitura por offset/timestamp)                                                                                                                                               | D6      |
| Consumo ordenado por chave           | Um consumidor SAC por partição com `consumerUpdateListener` (retoma do `consumer_offset` do banco) e fila serial por partição (`EventConsumer`); ver [ADR-0001](adr/0001-rabbitmq-streams.md)                                                | D6      |
| Retentativas e DLQ                   | 5 tentativas locais com backoff; quorum queues `<env>.<consumidor>.retry.1m/10m/1h` com TTL e dead-letter para `retry.return`; DLQ `<env>.<consumidor>.dlq` + tabela `dead_letter`                                                           | D6      |
| Bloqueio por chave                   | `blocked_key` e `parked_message`; em consumidor ordenado a chave é bloqueada já na retentativa atrasada (design D6)                                                                                                                          | D6      |
| Filas de jobs                        | Quorum queues com ack manual, prefetch e DLQ por fila (`JobQueue`, `startJobWorker`); o worker conta as falhas                                                                                                                               | D6      |
| Clientes                             | `rabbitmq-stream-js-client` 1.1.0 (streams, com adaptador próprio: roteamento murmur3 e publisher por partição com confirmação) e `amqplib` 2 (filas), atrás de `@broker/messaging`                                                          | D6      |
| Outbox / inbox                       | `EventPublisher` grava na `outbox_event` + `pg_notify`; `OutboxRelay` com `LISTEN/NOTIFY`, polling, `FOR UPDATE SKIP LOCKED` e `publishingId` = `seq` (deduplicação no broker); `processed_event` + `consumer_offset` na transação do efeito | D7      |
| Envelope e esquemas em runtime       | TypeBox 1.x (`typebox`) + Ajv 2020 com `ajv-formats`; envelope de RN-MSG-B §4; tolerant reader                                                                                                                                               | D2      |
| Ferramenta de DLQ                    | `DlqAdmin` + API HTTP `/admin/dlq` (sem framework) + CLI `broker-dlq`; descarte gera `messaging.dead_letter_discarded` auditável                                                                                                             | D6      |
| Registro de esquemas (RN-BE-081)     | `contracts/` versionado no monorepo: TypeBox → JSON Schema + AsyncAPI 3 em `contracts/generated/` (`pnpm contracts:generate`); `pnpm contracts:check` compara com o `main`                                                                   | D8      |
| Contrato de API síncrona (RN-BE-080) | TypeBox → OpenAPI 3.1 em `contracts/http/`                                                                                                                                                                                                   | D8      |
| RPC síncrono interno                 | HTTP/JSON com `undici`, disjuntor `opossum`, timeout explícito                                                                                                                                                                               | D11     |

## Dados

| Conceito                 | Tecnologia                                                                                                                                                                                                           | Decisão |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Banco de dados           | PostgreSQL 17 em Docker; um database e duas credenciais (`<svc>_app`, `<svc>_migrator`) por serviço                                                                                                                  | D4      |
| Acesso a dados           | Kysely 0.29 + `pg` (`@broker/persistence`); `numeric` → `Decimal` e `int8` → `bigint` na leitura (parser de tipos do pool), `Decimal` → string exata na escrita (plugin do Kysely)                                   | D4      |
| Migrações                | `Migrator` do Kysely (`kysely/migration`), tabela `schema_migration`, em contêiner one-shot com `<svc>_migrator` (`runMigrationsFromEnv`); migrações-base reutilizáveis (`baseMigrations`)                           | D4      |
| Tabelas append-only      | Grant sem `UPDATE`/`DELETE` + gatilho de recusa                                                                                                                                                                      | D4      |
| Eleição de líder         | Advisory lock de sessão do PostgreSQL (`pg_try_advisory_lock`) numa conexão dedicada, com heartbeat que confere o lock em `pg_locks` (`LeaderElector`)                                                               | D14     |
| Cache                    | Valkey (rate limit, revogação de tokens, idempotência rápida, cache da brapi, tempo real)                                                                                                                            | D16     |
| Armazenamento de objetos | MinIO (`documents`, `reports`, `brapi-raw`, `audit-anchors` com object lock/WORM)                                                                                                                                    | D16     |
| Criptografia de campo    | AES-256-GCM (`node:crypto`) com envelope encryption: chave-mestra em Docker secret, chaves de dados cifradas na tabela `data_key` (com rotação), contexto do campo como AAD; busca por HMAC-SHA256 com chave própria | D18     |
| Documentos               | `pdfkit` (PDF) e escritor CSV próprio                                                                                                                                                                                | D19     |

## Segurança e borda

| Conceito                            | Tecnologia                                                                                                                                                                                                                                                                                                      | Decisão    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Cofre de segredos                   | Docker secrets (`/run/secrets/*`), atrás de uma interface trocável por OpenBao/Vault                                                                                                                                                                                                                            | D18        |
| Feature flags                       | Configuração validada por ambiente + sobrescrita por conta no serviço dono                                                                                                                                                                                                                                      | D18        |
| Configuração                        | TypeBox + Ajv com coerção e padrões; `X_FILE` lê Docker secrets; falha rápida com a lista das variáveis inválidas, sem valores                                                                                                                                                                                  | D18        |
| Autenticação nos serviços           | `jose` (JWT ES256 pela JWKS, validade no relógio do ambiente); token de serviço por client credentials (`ServiceTokenProvider`); política de acesso obrigatória por rota                                                                                                                                        | D10        |
| Idempotência e concorrência         | `IdempotencyStore` (reserva em `idempotency_record` + caminho rápido no Valkey com `iovalkey`); `If-Match`/`ETag` com `version`                                                                                                                                                                                 | D16        |
| RPC interno                         | `RpcClient`: pool `undici` por dependência (bulkhead), timeout por tentativa, `opossum` (só falhas de disponibilidade contam), retentativa só idempotente                                                                                                                                                       | D11        |
| Sagas                               | `SagaOrchestrator` sobre `saga_instance`, com lease por passo (`deadline_at`) e retomada após reinício                                                                                                                                                                                                          | RN-PAD-030 |
| Proxy de borda e TLS                | Traefik com certificados `mkcert` em `*.broker.localhost`                                                                                                                                                                                                                                                       | D9         |
| API gateway e BFFs                  | Express (`api-gateway`, `bff-*`)                                                                                                                                                                                                                                                                                | D9         |
| Identidade e autenticação           | `identity-service` próprio: OAuth 2.1 + PKCE S256 (fluxo nativo por API), `jose` (ES256, JWKS rotacionável em `signing_key`), argon2id do `node:crypto`, `otplib` (TOTP), `@simplewebauthn/server`, refresh opaco com rotação e detecção de reuso                                                               | D10        |
| Revogação e assinatura nos serviços | `RevocationList` (Valkey, `revoked:session:*`/`revoked:signature:*`) no `Authenticator`; `SignatureVerifier` (token `sig+jwt` por escopo, rota com `signature`) e step-up (`stepUp`/`requireStepUp` pelo claim `mfa_time`) no `service-kit`                                                                     | D9, D10    |
| Trilha de auditoria                 | `audit-service`: `audit_record` append-only com `seq` contínuo e `hash = SHA-256(prev_hash ‖ JSON canônico)`; verificação diária pela rotina `audit_chain_verify` e âncora no bucket `audit-anchors` com PUT condicional (`If-None-Match`, `@aws-sdk/client-s3`); consulta só `BO_AUDITOR`/`BO_ADMIN`, auditada | D4, D16    |

## Observabilidade

| Conceito                | Tecnologia                                                                                                                                                                                                                                                     | Decisão |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Traces, métricas e logs | SDK OpenTelemetry (`node --import @broker/service-kit/telemetry`, hook ESM `import-in-the-middle`): HTTP, Express, `pg`, `amqplib` e `undici` automáticos; spans manuais nos consumidores a partir do `traceparent` do envelope; OTLP para `grafana/otel-lgtm` | D17     |
| Logs estruturados       | `pino` JSON com `timestamp` (relógio do ambiente), `wall_clock_at` (máquina), `correlation_id`, `trace_id` e mascaramento por nome de campo em qualquer profundidade                                                                                           | D17     |
| Painéis e alertas       | Versionados em `infra/observability/`                                                                                                                                                                                                                          | D17     |

## Testes, CI e ambiente

| Conceito                | Tecnologia                                                                                                                                                   | Decisão |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Unitários e componente  | Vitest (cobertura v8, ≥ 80% em `domain/`); `supertest` para HTTP                                                                                             | D20     |
| Testes de propriedade   | fast-check                                                                                                                                                   | D20     |
| Integração              | Testcontainers (PostgreSQL, RabbitMQ, Valkey, MinIO, Mailpit)                                                                                                | D20     |
| Golden master           | YAML em `scenarios/<domínio>/<ID>.yaml` + runner com relógio virtual e semente (`pnpm scenarios`)                                                            | D20     |
| Carga e caos            | k6 em contêiner; Toxiproxy                                                                                                                                   | D20     |
| CI                      | GitHub Actions + Turborepo (`--affected`); Semgrep, `osv-scanner`, `gitleaks`, `syft` (SBOM), `cosign` keyless; mesmos comandos localmente (`pnpm ci:local`) | D21     |
| Versões e changelog     | Conventional Commits (hook + CI), semver e `CHANGELOG.md` por pacote (`pnpm release`), versão e commit no `/info`                                            | D21     |
| Contêineres e ambientes | Dockerfile multi-stage (`node:24-slim`, não-root) e Docker Compose com perfis `infra`/`core`/`full`                                                          | D22     |
| E-mail, SMS e push      | Mailpit (e-mail, relay só para `MAIL_RELAY_ALLOWLIST`) e `message-sink` (SMS/push)                                                                           | D16     |
| Simuladores externos    | `pix-simulator`, `kyc-simulator` e `message-sink` sobre `@broker/simulator-kit` (falhas e UI)                                                                | D16     |
| Webhooks assinados      | `@broker/webhooks`: HMAC-SHA256 `timestamp.corpo`, desvio ≤ 5 min, fila com backoff 1 s → 1 h                                                                | D16     |

## Conflitos e simplificações

- **Cofre de segredos**: Docker secrets simulam o cofre localmente (D18).
- **Banco por serviço**: localmente há uma única instância PostgreSQL; o isolamento é por database e credencial, não por processo (D4).
- **Rateio (ADR-0004, RN-FEE-031)**: o ADR fala em "maior resto com resíduo para o maior valor". A implementação (`allocate` em `@broker/domain-kernel`) combina as duas regras: cada item recebe a parte truncada em centavos, e os centavos que sobram (no máximo n − 1) vão um por item na ordem **maior resto → maior peso (notional) → menor `trade_id`** (UUID v7, o mais antigo). O domínio só exige desempate determinístico (D5).
- **Formatos legíveis não definidos no domínio (RN-PAD-061)**: número da nota = sequencial por conta exibido com 9 dígitos (`000000042`); protocolo = `PREFIXO-AAAAMMDD-XXXXXXXX` com 8 caracteres Crockford base32 aleatórios (ex.: `SAQ-20261019-7K3M9Q2X`), não sequencial (RN-PAD-062).
- **DV da conta (RN-ACC-001)**: módulo 11 com pesos 2..9 da direita para a esquerda; restos que dariam DV 10 ou 11 viram 0. Por isso uma troca de dígito que leva a soma entre esses dois restos não é detectada (limitação conhecida do módulo 11).
- **Tempo sem `Temporal`**: o Node 24 ainda não tem a API `Temporal`. `Instant` (ms UTC) e `BusinessDate` (data civil) ficam em `@broker/domain-kernel`, e o fuso `America/Sao_Paulo` é resolvido com `Intl.DateTimeFormat`.
- **Grade da Quarta-feira de Cinzas**: o domínio só diz "pregão a partir das 13:00". A semente desloca as fases anteriores na mesma proporção da grade padrão (pré-pregão 12:00, pré-abertura 12:45).
- **Partições dos streams**: 3 por padrão no ambiente local; a tabela de RN-MSG-B-002 vale para `staging` (D6).
- **Imagem do MinIO**: a MinIO deixou de publicar imagens da edição comunitária no Docker Hub e no Quay. O ambiente usa `pgsty/minio` (build comunitário do código oficial, mantido pelo projeto Pigsty) com tag fixa. A imagem já traz o cliente `mc`, usado no init dos buckets.
- **mkcert em contêiner**: a CA local e o certificado são gerados por um serviço one-shot (`certs`), para não exigir o mkcert instalado na máquina (RN-ENV-030). Para o navegador confiar, importe `infra/certs/ca/rootCA.pem`.
- **WORM do `audit-anchors`**: S3 não impede um novo `PUT` na mesma chave; com versionamento e object lock em modo `COMPLIANCE`, o `PUT` cria outra versão e a versão gravada não pode ser alterada nem apagada até o fim da retenção (10 anos por padrão).

- **Tabelas append-only**: duas barreiras independentes. O usuário `<svc>_app` perde UPDATE/DELETE/TRUNCATE, e o gatilho `forbid_mutation()` recusa essas operações até para o dono da tabela (`makeAppendOnly`).
- **Limite da eleição de líder**: entre a queda real da conexão e o próximo heartbeat, o antigo líder ainda pode se achar líder. Quem escreve sob liderança deve escrever no mesmo banco (a queda da sessão derruba a transação) ou usar um _fencing token_.
- **Consumidores do identity (catálogo de eventos)**: o catálogo lista só `account.status_changed`. Para o `account_id` do token, o identity também consome `customer.created` e `account.opened`, sem mudar os payloads (decisão do grupo 13). O consumo liga com `CONSUME_CUSTOMER_EVENTS` quando o customer-service publicar.
- **E-mail e SMS de segurança fora do notification-service**: o link de recuperação, o convite do backoffice e o OTP por SMS levam segredo e saem direto do identity (SMTP → Mailpit, HTTP → message-sink). Os avisos sem segredo continuam como eventos (`identity.new_device_detected` etc.).
- **argon2id sem dependência nativa**: o design citava o pacote `argon2`; o identity usa `crypto.argon2` do Node 24 (mesmo algoritmo, formato PHC), sem script de build.
- **Consumidor genérico**: a chave `'*'` nos `handlers` do `EventConsumer` recebe os tipos sem handler próprio (sem conferir versão). É o que a trilha de auditoria usa para gravar todo evento `auditable` de um tópico.
- **Disparo duplo no failover**: o agendador trava a linha `scheduler_state` a cada passo e grava `routine_execution` com `ON CONFLICT DO NOTHING`, na mesma transação da outbox. Dois "líderes" ao mesmo tempo (o limite acima) ainda geram um único `routine.triggered` por rotina e data.
- **Datas técnicas no relógio do banco**: `created_at`, `processed_at` e afins das tabelas técnicas usam `now()` do PostgreSQL. Instantes de negócio (`occurred_at`) vêm sempre do relógio do ambiente (RN-CLK-004).

- **Ordem com retentativa atrasada (design D6)**: o design bloqueava a chave só na DLQ, o que deixaria mensagens seguintes passarem na frente durante até ~1h11 de retentativas. Decisão do grupo 5: nos consumidores ordenados, a chave é bloqueada já na primeira retentativa atrasada (`blocked_key.reason = 'RETRYING'`).
- **Filas por consumidor**: as filas de retentativa e a DLQ usam o nome do consumidor (`<env>.<consumidor>.dlq`), que é o `<svc>` do design quando o serviço tem um consumidor só. Um serviço com vários consumidores tem uma DLQ para cada.
- **Contador de entregas no RabbitMQ 4**: um `nack` com requeue não incrementa o `x-delivery-count` das filas quorum, então o limite de entregas da fila não pegava jobs que falham sempre (voltavam em laço). O worker de jobs conta as falhas num cabeçalho próprio e manda para a DLQ no limite.
- **Contornos do cliente de streams**: ver [ADR-0001](adr/0001-rabbitmq-streams.md).

- **Feature flag desligada**: a resposta é `403 FEATURE_UNAVAILABLE`. O domínio só diz "erro de funcionalidade indisponível"; `503` sugeriria "tente de novo" e `404` esconderia a rota.
- **`If-Match` ausente**: `428 IF_MATCH_REQUIRED` (RFC 6585), para o cliente não sobrescrever sem saber a versão.
- **Idempotência**: a chave é reservada no banco antes do caso de uso; uma segunda requisição simultânea recebe `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`. Respostas `5xx` não são guardadas (o cliente pode repetir); erros `4xx` de negócio são guardados como resposta final.
- **Migrações fora de ordem**: o migrador aceita migrações-base novas (`0000_platform_*`) depois das do serviço (`0001_*`), porque são independentes. Sem isso, cada migração nova da plataforma quebraria os serviços já implantados.
- **Lease da saga**: o passo interrompido por uma queda roda de novo quando o lease vence; por isso passos retomáveis precisam ser idempotentes.

## Versões da infraestrutura local

| Componente      | Imagem                                     |
| --------------- | ------------------------------------------ |
| PostgreSQL      | `postgres:17.11-alpine`                    |
| RabbitMQ        | `rabbitmq:4.3.6-management-alpine`         |
| Valkey          | `valkey/valkey:8.1.10-alpine`              |
| MinIO           | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` |
| Mailpit         | `axllent/mailpit:v1.31.6`                  |
| Observabilidade | `grafana/otel-lgtm:0.37.0`                 |
| Traefik         | `traefik:v3.7.15`                          |
| mkcert          | `v1.4.4` (binário verificado por SHA-256)  |
| Runtime         | `node:24-slim`                             |
