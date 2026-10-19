# Design

## Context

- O repositório `broker-node` está vazio (só `README.md`, o link `broker-docs/` e a configuração do OpenSpec). Motivação em `proposal.md`.
- `broker-docs` é a fonte das regras e é agnóstico de tecnologia. Esta implementação escolhe a stack e registra o mapeamento em `docs/mapeamento-tecnologico.md` (RN-BE-082). Se houver conflito entre a implementação e o domínio, vale o domínio, e o conflito é registrado.
- Restrições dadas pelo dono do projeto: **Node.js + TypeScript**, **PostgreSQL em Docker**, **toda a infraestrutura em Docker**, **microsserviços reais** (um contêiner por serviço), **RabbitMQ** como barramento (usando streams) e **Express** como framework HTTP. O frontend fica fora.
- Máquina de desenvolvimento: WSL2 com Node 24 (via nvm). O ambiente precisa caber numa máquina de estudo, o que pede perfis de subida (`infra`, `core`, `full`).

## Goals / Non-Goals

**Goals:**
- Uma arquitetura de referência em Node/TS que cumpra os requisitos das 29 specs e que possa ser entregue em fases independentes.
- Bibliotecas de plataforma (`packages/*`) prontas na Fase 0, para que cada serviço novo só implemente domínio, casos de uso e adaptadores.
- Determinismo e reprodutibilidade (golden master, relógio virtual, sementes) desde o início.
- Isolamento real entre serviços: um database e uma credencial por serviço, sem acesso cruzado, e comunicação só por eventos e pelas duas exceções síncronas.

**Non-Goals:**
- Apps web, mobile e desktop, e a UI do backoffice. As UIs mínimas dos simuladores entram.
- Orquestração de produção (Kubernetes, IaC de nuvem, canário real). O pipeline de entrega fica descrito e preparado (imagens assinadas, SBOM), mas os alvos são local, CI e sandbox em Docker.
- Atingir os números de carga de `staging` (10 mil usuários, 2 mil ordens/s) numa única máquina. Os testes de carga existem e medem; as metas viram linha de base.

## Decisions

### D1. Monorepo com pnpm workspaces e Turborepo
```
apps/                  # um diretório por serviço implantável
  identity-service/ customer-service/ ledger-service/ ... matching-engine/
  api-gateway/ bff-web/ bff-mobile/ bff-desktop/ bff-backoffice/ realtime-gateway/
  pix-simulator/ kyc-simulator/ message-sink/
packages/
  domain-kernel/       # Money, Price, Quantity, TaxId, BusinessDate, Percentage, erros de domínio
  clock/               # porta de relógio + modos REAL/ACCELERATED/VIRTUAL
  calendar/            # funções de calendário (RN-CAL-002) sobre dados locais
  ids/                 # UUID v7 e formatos legíveis (conta, nota, protocolo)
  messaging/           # envelope, outbox relay, consumidor com inbox, retry, DLQ, parked keys
  service-kit/         # bootstrap Express, config, logs, métricas, traces, health, Problem Details, idempotência, auth
  persistence/         # Kysely + pg, migrador, helpers de transação/outbox/inbox, crypto de campo
  testing/             # builders, Testcontainers, relógio virtual, geradores de CPF, runner de golden master
  eslint-config/ tsconfig/
contracts/             # esquemas de eventos (JSON Schema + AsyncAPI), OpenAPI por serviço, compat check
scenarios/             # golden master (ME-*, ORD-*, RSK-*, LED-*, FEE-*, CLR-*, PM-*, IR-*, CA-*, BTC-*, CAL-*)
infra/                 # compose, Dockerfile base, init do Postgres, RabbitMQ definitions, Traefik, otel
docs/                  # mapeamento-tecnologico.md, primeiros-passos.md, ADRs da implementação
```
- **Por quê**: contratos e bibliotecas mudam junto com os serviços; o Turborepo faz build e teste só do que foi afetado, e isso mantém build, teste e imagem independentes por serviço (RN-CICD-001/002).
- **Alternativas**: um repositório por serviço (custo alto de versionar contratos para um estudo solo); Nx (mais pesado e opinativo do que o necessário).

### D2. Runtime e linguagem
- Node.js 24 LTS, TypeScript em modo `strict` com ESM, build com `tsc` e `tsx` no desenvolvimento.
- **TypeBox** define os esquemas uma única vez em TS. Desses esquemas saem: JSON Schema (eventos), OpenAPI 3.1 (rotas) e a validação em runtime com Ajv, para corpo de requisição, envelope de eventos e configuração.
- **Express 5**, por escolha do dono, com middlewares próprios no `service-kit` (validação por esquema, Problem Details, correlação, idempotência, autenticação, métricas).
- **Alternativas**: Zod (sem geração nativa e estável de JSON Schema/AsyncAPI); Fastify/NestJS (descartados pelo dono).

### D3. Arquitetura hexagonal por serviço
Cada `apps/<serviço>/src` segue `domain/`, `application/`, `adapters/inbound`, `adapters/outbound`, `config/`, com `migrations/`, `tests/` e `docs/` ao lado (RN-BE §1). O `domain` não importa nada de infraestrutura. Regras do ESLint (`import/no-restricted-paths` e `no-restricted-syntax` para `Date.now`, `new Date()` sem argumento e `Math.random`) falham o build em caso de violação (RN-BE-001, ADR-0009).

### D4. PostgreSQL: um database por serviço numa instância local
- Localmente, um único contêiner PostgreSQL 17. Um script de init cria, por serviço, o database `<svc>`, o usuário `<svc>_app` (DML apenas) e o usuário `<svc>_migrator` (DDL), com `REVOKE CONNECT ... FROM PUBLIC` (RN-DB-001, RN-DB-032).
- Tabelas append-only (`ledger_entry`, `journal`, `custody_movement`, `order_event`, `audit_record`, `trade_allocation`, `engine_journal`) sem `UPDATE`/`DELETE` para `<svc>_app`, e com gatilho de recusa como segunda barreira.
- **Kysely + `pg`**: SQL explícito e tipado, bom para regras financeiras. As colunas `numeric` chegam como string e viram `Decimal` no adaptador. As migrações usam o `Migrator` do Kysely e rodam num contêiner one-shot com o usuário migrador antes do serviço subir (RN-DB-020/021, expand/contract).
- Particionamento mensal declarativo nas tabelas de alto volume (RN-DB-013) entra na Fase 7. As tabelas nascem com chave e índices compatíveis com isso.
- **Alternativas**: um contêiner Postgres por serviço (isola mais, mas são cerca de 22 bancos rodando; fica como opção de perfil); Prisma/Drizzle (abstraem demais o controle de transação, `FOR UPDATE SKIP LOCKED` e tipos `numeric`).

### D5. Decimal e objetos de valor
`decimal.js` com precisão de 34 dígitos e `rounding` sempre explícito em cada operação que arredonda. `Money`, `Price`, `Quantity` (bigint), `Percentage`, `TaxId` e `BusinessDate` ficam em `domain-kernel`, com testes de propriedade (fast-check) para Σ rateio = total, soma zero do journal e arredondamento determinístico (ADR-0004).
- **Premissa registrada**: no rateio com empate (RN-FEE-031), o resíduo vai para o **menor** `trade_id` (lexicográfico do UUID v7, que equivale ao mais antigo). O domínio só exige desempate determinístico.

### D6. RabbitMQ: super streams para eventos e comandos, quorum queues para o resto
- **Eventos e comandos** (`<env>.<contexto>.events`, `<env>.engine.commands`): **super streams** (streams particionados). A chave de roteamento é o `partitionKey` do envelope (hash para a partição), o que garante a ordem por chave e permite releitura por offset ou timestamp e retenção por tamanho e idade (RN-MSG-B §1, §3).
- **Consumo ordenado**: cada serviço consome com **Single Active Consumer** por partição, nomeado pelo serviço. Isso dá um consumidor ativo por partição, failover automático e processamento serial por chave (RN-MSG-B-032). O offset é gravado **no banco do serviço**, na mesma transação da inbox e do efeito, e o consumidor retoma do offset salvo. Assim o efeito é exatamente-uma-vez sobre uma entrega pelo menos uma vez (RN-MSG-B-030/031).
- **Retentativas**: até 5 tentativas locais com backoff (100 ms a 5 s). Depois disso, a mensagem vai para **quorum queues** de retry com TTL e dead-letter (`retry.1m`, `retry.10m`, `retry.1h`), que devolvem ao handler. Por fim, vai para a DLQ (`<env>.<svc>.dlq`, quorum queue) com o registro espelhado na tabela `dead_letter` (RN-MSG-B-033/034).
- **Bloqueio por chave** (RN-MSG-B-035): nos fluxos ordenados, a ida para a DLQ grava `blocked_key(consumer, partition_key)`. As mensagens seguintes daquela chave são estacionadas em `parked_message` (o offset continua avançando para as outras chaves) e são reprocessadas em ordem quando a chave é liberada pela ferramenta de DLQ (RN-MSG-B-036).
- **Jobs** (relatórios, exportações LGPD): quorum queues com ack manual e prefetch.
- **Bibliotecas**: `rabbitmq-stream-js-client` (streams, super streams e SAC) e `amqplib` (filas). Ambas ficam escondidas atrás das portas `EventPublisher` e `EventConsumer` do pacote `@broker/messaging`.
- **Partições locais**: o número de partições é configurável (padrão local 3; a tabela de referência de RN-MSG-B-002 vale para `staging`).
- **Alternativas**: Redpanda/Kafka (mais natural para logs particionados; descartado por escolha do dono, mas a porta de mensageria permite a troca); filas clássicas com consistent-hash exchange (sem releitura por offset, o que quebra a reconstrução de read models).

### D7. Outbox relay e inbox
- Tabela `outbox_event` por serviço (RN-DB §4). O relay roda em processo, acordado por `LISTEN/NOTIFY` e com polling de segurança. Ele lê com `FOR UPDATE SKIP LOCKED`, em ordem de inserção, publica com confirmação do broker e marca `published_at`. A publicação é em série por `partition_key` para manter a ordem (RN-PAD-022). Uma limpeza remove o que foi publicado há mais de 7 dias.
- Inbox `processed_event(event_id, consumer)` mais `consumer_offset(consumer, stream, partition, offset)`, na mesma transação do efeito.
- O Motor é a exceção: publica a partir de `engine_output` (já sequenciado e durável) com um relay dedicado (RN-MSG-B-040).

### D8. Contratos e registro de esquemas
- `contracts/events/<eventType>/v<N>.ts` (TypeBox) gera JSON Schema e um documento AsyncAPI 3. `contracts/http/<serviço>.ts` gera OpenAPI 3.1.
- O produtor valida o payload antes de gravar na outbox. O consumidor valida o envelope e ignora campos desconhecidos (tolerant reader).
- Uma verificação de compatibilidade roda no CI e compara os esquemas com os do `main`: remover ou mudar o tipo de um campo sem subir a versão reprova o build (RN-MSG-B-020..023, RN-CICD §2).
- **Alternativa**: Confluent/Apicurio Schema Registry (atrelado a Kafka/Avro, mais um contêiner pesado).

### D9. Borda: Traefik, api-gateway e BFFs
- **Traefik** (Docker) termina TLS com certificados locais gerados pelo `mkcert` e roteia `api.*` para o `api-gateway`, `ws.*` para o `realtime-gateway` e `bank.*`/`kyc.*`/`mail.*` para as UIs dos simuladores.
- **api-gateway** (Express): valida o JWT pela JWKS do identity, consulta a lista de revogação no Valkey, aplica rate limit com janela deslizante no Valkey, CORS, limite de corpo, headers de segurança, `X-Correlation-Id`, `426` por versão e roteamento para os BFFs (RN-API-*).
- **BFFs** (Express): o BFF web faz o *token handler* (Authorization Code + PKCE, cookies `HttpOnly`/`SameSite=Strict`, anti-CSRF). Todos agregam em lote e emitem `audit.*`.
- **Alternativa**: Kong/Envoy como gateway (pouco valor de estudo no código e mais configuração declarativa para manter).

### D10. Identidade própria
O `identity-service` implementa OAuth 2.1 com Authorization Code + PKCE e refresh com rotação, tokens ES256 via `jose` com JWKS rotacionável, `argon2id` para senha e assinatura, TOTP (`otplib`), WebAuthn (`@simplewebauthn/server`), dois realms e client credentials para serviços.
- **Por quê**: assinatura eletrônica com escopos, step-up por `amr`, bloqueios específicos e eventos de domínio são regras do sistema; implementar é parte do estudo.
- **Alternativa**: Keycloak em Docker (resolve OIDC, mas as regras de assinatura e de eventos ficariam fora dele ou em extensões Java).

### D11. RPC síncrono interno
HTTP/JSON com `undici` (keep-alive, pool por dependência para bulkhead), token de serviço, timeout explícito (pré-trade: 200 ms), disjuntor (`opossum`) e retentativa só em operação idempotente (RN-ARQ-002, RN-API-050). Só existem `risk.PreTradeCheck`, `risk.CreateHold` e `risk.ReleaseHold`.
- **Alternativa**: gRPC (mais rápido, mas exige toolchain de IDL; a decisão pode ser revista na Fase 7 se o p99 do pré-trade não fechar).

### D12. Motor de negociação
- Um processo Node por instância. Cada **partição** de `engine.commands` (SAC) é um *sequenciador* que carimba `input_seq`, `ts` (relógio do ambiente) e semente.
- Antes do matching, o lote de entradas é gravado em `engine_journal` no Postgres do Motor (`synchronous_commit = on`, *group commit* por micro-lote).
- Depois do matching em memória, as saídas vão para `engine_output` com `engine_seq`, e um relay as publica em `engine.events`.
- **Livro**: níveis de preço ordenados (árvore ordenada por preço inteiro em centavos) com fila FIFO duplamente ligada por nível e índice `order_id → nó`. Nada no código usa iteração não determinística: só arrays e `Map` com ordem de inserção, sem `Math.random` e sem relógio.
- **Snapshots** em `engine_snapshot` (jsonb comprimido) a cada 10 mil entradas ou 5 min. A recuperação carrega o último snapshot e reprocessa o journal, regerando os mesmos `engine_seq`; o relay deduplica pelo `engine_seq` já publicado (RN-REC-*).
- **Failover**: SAC com lease por partição (advisory lock no Postgres), para evitar dois escritores no mesmo livro.
- A meta de p99 < 1 ms vale só para o matching em memória (entrada → saída) e é medida à parte da persistência.
- **Alternativas**: o próprio stream de comandos como journal (o `input_seq`, o carimbo de tempo e a semente precisam ser do sequenciador, não do broker); journal em arquivo local (durabilidade e backup mais difíceis no Docker).

### D13. Risco com projeção em memória
- As contas são mapeadas para N partições lógicas (hash de `account_id`), as mesmas do particionamento dos streams `ledger`, `custody`, `oms` e `risk`. Localmente, uma instância é dona de todas as partições.
- Dentro do processo, uma fila assíncrona por conta (*keyed mutex*) serializa as operações (RN-RSK-001).
- Os holds são gravados no Postgres do Risco (e na outbox) **antes** de responder `APPROVED`. A projeção (P2, U, H, posições, preços) fica em memória, com snapshot periódico mais offsets em `account_risk_projection`.
- Com várias instâncias, o roteamento do pré-trade para a dona da partição usa hashing consistente com a lista de donos no Valkey. Isso entra na Fase 7; até lá, uma instância ativa com outra em espera.

### D14. Eleição de líder
Advisory locks de sessão no Postgres do próprio serviço, com heartbeat, para o agendador, o líder da fila da brapi e as partições do Risco (RN-ENV-021, RN-BRP-040). Não há componente extra de coordenação.

### D15. Relógio e calendário
- `@broker/clock`: a porta `Clock`. Em `REAL` usa o tempo do sistema; em `ACCELERATED`/`VIRTUAL` segue `clock.ticked`, publicado pelo `scheduler-service`, que é o dono do tempo do ambiente. Nos testes, `advance_to` controla o relógio.
- `@broker/calendar`: funções puras sobre os dados do calendário. Cada consumidor guarda uma cópia local alimentada por `calendar.updated`. A semente traz o calendário da B3 de 2026 e 2027.

### D16. Cache, storage e e-mail
- **Valkey**: rate limit, revogação de tokens, caminho rápido da idempotência (o banco continua sendo a fonte), cache da brapi, snapshots do tempo real e coalescência.
- **MinIO**: buckets `documents` (onboarding), `reports`, `brapi-raw` (30 dias) e `audit-anchors`, este com *object lock* (WORM) para RN-AUD-002. Uploads e downloads só por URL pré-assinada.
- **Mailpit**: caixa de captura de e-mail. SMS e push são registrados pelo `message-sink`, que tem UI própria.

### D17. Observabilidade
O SDK OpenTelemetry para Node (auto-instrumentação de HTTP, `pg`, `amqplib` e `undici`, mais spans manuais nos consumidores de streams com `traceparent` do envelope) envia para o contêiner **`grafana/otel-lgtm`**, que reúne collector, Tempo, Prometheus/Mimir, Loki e Grafana. Logs com `pino` em JSON, mascaramento por *redact paths* e exportação OTLP. Painéis e alertas ficam versionados em `infra/observability/` (RN-OBS-*).

### D18. Segredos, criptografia de campo e feature flags
- Os segredos vêm de **Docker secrets** (`/run/secrets/*`), simulando o cofre; nada vai em imagem ou repositório (RN-BE-060, RN-BRP-090).
- Criptografia de campo com AES-256-GCM (`node:crypto`) usando *envelope encryption*: uma chave de dados por serviço, cifrada por uma chave-mestra que vem de segredo. O hash de busca é HMAC-SHA256 com chave própria (RN-DB-031).
- Feature flags ficam na configuração validada por ambiente, com sobrescrita por conta numa tabela do serviço dono (RN-PAD-072). Um serviço de flags dedicado seria peso desnecessário para o estudo.

### D19. Documentos
PDF com `pdfkit` (marca d'água por página, rodapé com `document_id` e SHA-256) e CSV com um escritor próprio nas duas variantes, pt-BR e técnica (RN-REL-001/005). A geração roda em workers do `reporting-service` consumindo a fila de jobs.

### D20. Testes
- **Vitest** para unitários e de componente; **fast-check** para testes de propriedade; **Testcontainers** (Postgres e RabbitMQ) para integração; **supertest** para HTTP.
- **Golden master**: arquivos YAML em `scenarios/`, independentes de tecnologia, executados por um runner que alimenta o domínio puro com relógio virtual e semente.
- **Contrato**: esquemas de `contracts/` mais expectativas declaradas pelos consumidores.
- **E2E**: fluxos via API contra o compose `ci`, sempre terminando com as reconciliações (RN-QA-010).
- **Carga**: k6 em contêiner. **Caos**: Toxiproxy entre os serviços e o broker/banco, mais scripts que derrubam contêineres.
- Todo teste de regra cita o ID (`RN-*`) no nome (RN-QA-001).

### D21. CI
GitHub Actions com Turborepo, rodando só o que foi afetado: lint e format, typecheck, unitários com cobertura (≥ 80% no domínio), integração, contrato, compatibilidade de esquemas, Semgrep (SAST), `osv-scanner` (SCA), `gitleaks`, build de imagem com SBOM (`syft`) e assinatura (`cosign`), e testes de componente (RN-CICD §2). As versões seguem semver por serviço, e o `/info` expõe versão e commit.

### D22. Docker e perfis
- Um `Dockerfile` multi-stage único, parametrizado pelo serviço (`pnpm deploy --filter`), com imagem final `node:24-slim` e usuário não-root.
- `infra/compose/compose.yml` traz a infraestrutura e os serviços com `profiles: [core]` ou `[full]`, mais um serviço one-shot de migração por database.
- Comandos: `pnpm env:up [infra|core|full]`, `pnpm env:seed`, `pnpm env:down`.
- O sandbox é o mesmo compose com outro `-p broker-sandbox`, outro `.env` (relógio `ACCELERATED`, calendário sempre útil, provedor sintético) e portas e rede próprias (RN-PAD-080).
- Os limites de memória por contêiner ficam definidos para caber em cerca de 16 GB no perfil `full`.

### D23. Ordem de entrega
As tarefas seguem as fases do roadmap de `broker-docs`. A Fase 6 do roadmap original (apps mobile e desktop) vira só a parte de backend dos canais (BFF mobile, BFF desktop, `book_l3`, tokens de push). Recomenda-se abrir uma change detalhada por fase antes de aplicá-la. Esta change é a referência de escopo e de decisões.

## Risks / Trade-offs

- **[Risco] Maturidade do cliente JS de RabbitMQ Streams** (super streams com SAC) → Spike na Fase 0 com testes de integração de ordem, failover e releitura. Tudo fica atrás da porta de `@broker/messaging`; se falhar, troca-se o adaptador (ex.: Redpanda) sem mexer nos serviços.
- **[Risco] DLQ com bloqueio por chave não é nativa em streams** → Implementação própria (`blocked_key` e `parked_message`) com testes dedicados de bloqueio, reprocessamento e ordem, além de alerta crítico.
- **[Risco] Latência do Motor em Node (GC, single thread)** → Estruturas sem alocação no caminho quente, preços como inteiros em centavos e medição isolada do matching. O p99 < 1 ms é meta de estudo, e o resultado é registrado.
- **[Risco] Footprint local de cerca de 30 contêineres** → Perfis `infra`/`core`/`full`, imagem base compartilhada e limites de memória. O desenvolvimento pode rodar serviços fora do contêiner com o perfil `infra`.
- **[Risco] Escopo muito grande para uma change** → Esta change é o roadmap; cada fase vira uma change própria com as specs relevantes refinadas antes do apply.
- **[Trade-off] Uma instância Postgres local para todos os serviços** → O isolamento é por database e credencial, não por processo. Uma falha do contêiner derruba todos os bancos localmente, o que é aceitável fora de `staging`.
- **[Risco] Identidade própria (OAuth) com falhas de segurança** → Seguir os RFCs, cobrir com testes de abuso e passar pelo checklist de revisão obrigatório para autenticação (Segurança de aplicação §2).
- **[Risco] Consumo da cota da brapi durante o desenvolvimento** → Provedor de fixtures/replay por padrão. O token real só entra por configuração explícita, e o job semanal de verificação de esquema faz 1–2 requisições (RN-BRP-095, RN-BRP-100).
- **[Trade-off] Docker secrets no lugar de cofre real** → Simplificação documentada no mapeamento tecnológico; a interface de leitura de segredos permite trocar por OpenBao/Vault depois.

## Migration Plan

- Projeto novo: não há dados nem serviços para migrar.
- Cada fase é entregue e validada pelo seu critério de pronto (E2E mais reconciliações) antes da seguinte.
- As migrações seguem expand/contract desde a primeira versão, então o rollback de qualquer serviço é voltar a imagem anterior (RN-CICD-012).
- Os esquemas de eventos começam em `v1`, e mudanças incompatíveis seguem RN-MSG-B-021.

## Open Questions

- **Q-01 (brapi)**: o endpoint de lista de tickers consome cota? Validar empiricamente na Fase 1. A estratégia padrão `PER_SYMBOL` funciona em qualquer caso, e a `HYBRID` é ligada por configuração.
- **Q-02 (brapi)**: o plano gratuito tem acesso a proventos? Detectado por `403` em runtime, com fallback para cadastro manual já previsto.
- **Partições por stream no ambiente local**: o padrão 3 é configurável e pode ser ajustado após medir a Fase 2, sem mudar specs nem tarefas.
