# Mapeamento tecnológico

Atende **RN-BE-082**: diz qual tecnologia implementa cada conceito do `broker-docs`, que é agnóstico de tecnologia. As decisões e alternativas estão em `openspec/changes/implementation-roadmap/design.md` (D1–D23). Se a implementação divergir do domínio, vale o domínio, e o conflito é registrado na seção [Conflitos e simplificações](#conflitos-e-simplificações).

Cada serviço novo acrescenta aqui as tecnologias específicas que usar.

## Plataforma e código

| Conceito                                 | Tecnologia                                                                              | Decisão |
| ---------------------------------------- | --------------------------------------------------------------------------------------- | ------- |
| Repositório e build                      | Monorepo com pnpm workspaces + Turborepo (build e teste só do que foi afetado)          | D1      |
| Runtime e linguagem                      | Node.js 24 LTS, TypeScript `strict` com ESM, `tsc` no build e `tsx` no desenvolvimento  | D2      |
| Esquemas e validação em runtime          | TypeBox (fonte única) + Ajv                                                             | D2      |
| Framework HTTP                           | Express 5 com middlewares do `@broker/service-kit`                                      | D2      |
| Arquitetura do serviço                   | Hexagonal (`domain/`, `application/`, `adapters/`, `config/`), garantida por ESLint     | D3      |
| Determinismo do domínio                  | Porta `Clock` (`@broker/clock`); ESLint proíbe `Date.now`, `new Date()` e `Math.random` | D3, D15 |
| Decimal e objetos de valor               | `decimal.js` (34 dígitos, arredondamento explícito) em `@broker/domain-kernel`          | D5      |
| Identificadores                          | UUID v7 e formatos legíveis em `@broker/ids`                                            | D1      |
| Relógio do ambiente (REAL/ACCEL/VIRTUAL) | `@broker/clock`, com `clock.ticked` publicado pelo `scheduler-service`                  | D15     |
| Calendário de pregão                     | `@broker/calendar` (funções puras) + cópia local alimentada por `calendar.updated`      | D15     |
| Lint e formatação                        | ESLint (flat config, `typescript-eslint`, `eslint-plugin-import-x`) + Prettier          | D3      |

## Barramento e mensageria

| Conceito                             | Tecnologia                                                                                                    | Decisão |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------- |
| Barramento de eventos e comandos     | RabbitMQ 4 com **super streams** (partição por `partitionKey`, releitura por offset/timestamp)                | D6      |
| Consumo ordenado por chave           | Single Active Consumer por partição, offset gravado no banco do serviço                                       | D6      |
| Retentativas e DLQ                   | Quorum queues com TTL (`retry.1m/10m/1h`) e DLQ `<env>.<svc>.dlq` + tabela `dead_letter`                      | D6      |
| Bloqueio por chave (DLQ ordenada)    | Tabelas `blocked_key` e `parked_message` (implementação própria)                                              | D6      |
| Filas de jobs                        | Quorum queues com ack manual e prefetch                                                                       | D6      |
| Clientes                             | `rabbitmq-stream-js-client` (streams) e `amqplib` (filas), atrás das portas de `@broker/messaging`            | D6      |
| Outbox / inbox                       | `outbox_event` + relay com `LISTEN/NOTIFY` e `FOR UPDATE SKIP LOCKED`; `processed_event` + `consumer_offset`  | D7      |
| Registro de esquemas (RN-BE-081)     | `contracts/` versionado no monorepo: TypeBox → JSON Schema + AsyncAPI 3; verificação de compatibilidade no CI | D8      |
| Contrato de API síncrona (RN-BE-080) | TypeBox → OpenAPI 3.1 em `contracts/http/`                                                                    | D8      |
| RPC síncrono interno                 | HTTP/JSON com `undici`, disjuntor `opossum`, timeout explícito                                                | D11     |

## Dados

| Conceito                 | Tecnologia                                                                                          | Decisão |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ------- |
| Banco de dados           | PostgreSQL 17 em Docker; um database e duas credenciais (`<svc>_app`, `<svc>_migrator`) por serviço | D4      |
| Acesso a dados           | Kysely + `pg`; `numeric` convertido para `Decimal` no adaptador                                     | D4      |
| Migrações                | `Migrator` do Kysely em contêiner one-shot, padrão expand/contract                                  | D4      |
| Tabelas append-only      | Grant sem `UPDATE`/`DELETE` + gatilho de recusa                                                     | D4      |
| Eleição de líder         | Advisory locks de sessão do PostgreSQL com heartbeat                                                | D14     |
| Cache                    | Valkey (rate limit, revogação de tokens, idempotência rápida, cache da brapi, tempo real)           | D16     |
| Armazenamento de objetos | MinIO (`documents`, `reports`, `brapi-raw`, `audit-anchors` com object lock/WORM)                   | D16     |
| Criptografia de campo    | AES-256-GCM (`node:crypto`) com envelope encryption; busca por HMAC-SHA256                          | D18     |
| Documentos               | `pdfkit` (PDF) e escritor CSV próprio                                                               | D19     |

## Segurança e borda

| Conceito                  | Tecnologia                                                                                                        | Decisão |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------- |
| Cofre de segredos         | Docker secrets (`/run/secrets/*`), atrás de uma interface trocável por OpenBao/Vault                              | D18     |
| Feature flags             | Configuração validada por ambiente + sobrescrita por conta no serviço dono                                        | D18     |
| Proxy de borda e TLS      | Traefik com certificados `mkcert` em `*.broker.localhost`                                                         | D9      |
| API gateway e BFFs        | Express (`api-gateway`, `bff-*`)                                                                                  | D9      |
| Identidade e autenticação | `identity-service` próprio: OAuth 2.1 + PKCE, `jose` (ES256/JWKS), `argon2id`, `otplib`, `@simplewebauthn/server` | D10     |

## Observabilidade

| Conceito                | Tecnologia                                                                                                      | Decisão |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | ------- |
| Traces, métricas e logs | SDK OpenTelemetry para Node → contêiner `grafana/otel-lgtm` (collector, Tempo, Prometheus/Mimir, Loki, Grafana) | D17     |
| Logs estruturados       | `pino` em JSON com mascaramento por redact paths, exportação OTLP                                               | D17     |
| Painéis e alertas       | Versionados em `infra/observability/`                                                                           | D17     |

## Testes, CI e ambiente

| Conceito                | Tecnologia                                                                                          | Decisão |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ------- |
| Unitários e componente  | Vitest (cobertura v8, ≥ 80% em `domain/`); `supertest` para HTTP                                    | D20     |
| Testes de propriedade   | fast-check                                                                                          | D20     |
| Integração              | Testcontainers (PostgreSQL e RabbitMQ)                                                              | D20     |
| Golden master           | YAML em `scenarios/` + runner com relógio virtual e semente                                         | D20     |
| Carga e caos            | k6 em contêiner; Toxiproxy                                                                          | D20     |
| CI                      | GitHub Actions + Turborepo; Semgrep, `osv-scanner`, `gitleaks`, `syft` (SBOM), `cosign`             | D21     |
| Contêineres e ambientes | Dockerfile multi-stage (`node:24-slim`, não-root) e Docker Compose com perfis `infra`/`core`/`full` | D22     |
| E-mail, SMS e push      | Mailpit (e-mail) e `message-sink` (SMS/push)                                                        | D16     |

## Conflitos e simplificações

- **Cofre de segredos**: Docker secrets simulam o cofre localmente (D18).
- **Banco por serviço**: localmente há uma única instância PostgreSQL; o isolamento é por database e credencial, não por processo (D4).
- **Rateio com empate (RN-FEE-031)**: o resíduo vai para o menor `trade_id` (UUID v7, o mais antigo). O domínio só exige desempate determinístico (D5).
- **Partições dos streams**: 3 por padrão no ambiente local; a tabela de RN-MSG-B-002 vale para `staging` (D6).
