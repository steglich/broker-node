# Proposal

## Why

O repositório `broker-node` está vazio e vai ser a **implementação base** em Node.js + TypeScript do Home Broker simulado definido em `broker-docs` (especificação agnóstica de tecnologia). Antes de escrever código, precisamos de um plano único, em fases, que traduza as regras (`RN-*`, `RNF-*`, `INV-*`, `ADR-*`) em capacidades verificáveis, com uma escolha de stack e de infraestrutura (tudo em Docker) que sirva de referência para as próximas changes.

## What Changes

- Define a **stack** da implementação: Node.js 24 LTS + TypeScript (strict), Express 5, PostgreSQL em Docker (um database e um usuário por serviço), RabbitMQ (super streams para eventos e comandos, quorum queues para jobs, retentativas e DLQ), além de Valkey, MinIO, Mailpit e a stack de observabilidade OpenTelemetry/Grafana, todos em Docker.
- Organiza o repositório como **monorepo** (pnpm workspaces): um app por microssserviço (`apps/*`), bibliotecas compartilhadas (`packages/*`), contratos versionados (`contracts/`) e cenários golden master (`scenarios/`).
- Entrega as **fundações** transversais: objetos de valor (`Money`, `Price`, `Quantity`, `TaxId`, `BusinessDate`), relógio injetável, UUID v7, envelope de eventos, outbox/inbox, idempotência, Problem Details, logs JSON com mascaramento, health, métricas e traces.
- Implementa **todos os microsserviços de backend** do catálogo de `broker-docs` (identidade, onboarding, ledger, dados de referência, market data/brapi, sessão, OMS, Motor, FMS, risco, BTC, clearing, custódia, eventos corporativos, IR, notificações/engajamento, relatórios, aprovações, auditoria, agendador, gateway, BFFs e tempo real), além dos simuladores PIX, KYC e de entrega de mensagens.
- Divide a entrega nas **fases do roadmap** de `broker-docs/docs/11-roadmap/01-fases.md`: 0 (fundações), 1 (conta, dinheiro e preços), 2 (negociação básica), 3 (pós-negociação e carteira), 4 (ordens avançadas, proventos e IR), 5 (alavancagem, short e BTC), 6 (backends dos canais mobile/desktop) e 7 (endurecimento: sandbox, replay, carga, caos, LGPD).
- **Fora do escopo desta change**: todo o frontend (apps web, mobile, desktop e a UI do backoffice). Os BFFs e o gateway de tempo real entram, porque são backend. As UIs mínimas de inspeção dos simuladores (RN-SIM-005) entram como páginas servidas pelo próprio simulador.

## Capabilities

### New Capabilities

Fundações e plataforma:
- `local-environment`: ambiente local com um comando via Docker Compose (perfis `infra`, `core` e `full`), sementes, ambiente sandbox separado e primeiros passos (RN-ENV-030..032, RNF-091).
- `domain-primitives`: objetos de valor, aritmética decimal e arredondamento, IDs UUID v7, relógio injetável e funções de calendário compartilhadas (ADR-0004, ADR-0009, RN-PAD-001/060, RN-CLK-001).
- `event-messaging`: envelope padrão, outbox transacional, inbox idempotente, tópicos particionados por chave, retentativa, DLQ com bloqueio por chave e registro de esquemas (ADR-0008, RN-MSG-B-*, RN-PAD-020..023).
- `service-platform`: convenções comuns a todo serviço, como arquitetura hexagonal, configuração validada, erros RFC 9457, idempotência de API, logs, métricas, traces, health, paginação e rate limit (RN-BE-*, RN-API-*, RN-OBS-*).
- `routine-scheduling`: `scheduler-service`, modos de relógio (`REAL`, `ACCELERATED`, `VIRTUAL`), `clock.ticked`, rotinas idempotentes com dependências e catch-up (RN-CLK-*, RN-ROT-*).
- `external-simulators`: simulador PIX, provedor de KYC simulado e caixa de captura de e-mail/SMS/push, com webhooks assinados (RN-SIM-*, RN-PIXS-*, RN-KYCS-*, RN-MSG-001..003).
- `api-edge`: `api-gateway` e BFFs (web, mobile, desktop, backoffice) como backend, com token handler, CORS, headers de segurança e read-your-writes (RN-API-*, RN-AUTH-010/011, RN-PAD-011).
- `realtime-gateway`: conexões WebSocket, canais, snapshots, sequência, conflação e backpressure (RN-RT-*).

Domínio:
- `identity-access`: realms, credenciais, MFA, sessões, tokens, assinatura eletrônica e RBAC (RN-AUTH-*, RN-SIG-*, RN-AUTHZ-*).
- `customer-onboarding`: onboarding, KYC, suitability, conta de investimento, contas de saque, termos e cadastro (RN-ONB-*, RN-SUI-*, RN-ACC-*, RN-CAD-*, RN-TER-*).
- `ledger-funds`: ledger de partidas dobradas, saldos, depósito/saque PIX, saldo devedor, liquidação financeira D+2, ajustes e extrato (RN-LED-*, RN-DEP-*, RN-SAQ-*, RN-DEV-*, RN-LIQ-*, RN-AJU-*, RN-EXT-*).
- `reference-data`: instrumentos, universo negociável, regras de negociação com vigência, renomeações e calendário (RN-INS-*, RN-CAL-*).
- `market-data`: adaptador brapi (orçamento, fila única, cache, quarentena), preço de referência (glide e ruído), cotação/book/negócios/candles internos (RN-BRP-*, RN-SYN-*, RN-MD-*).
- `trading-session`: fases de mercado e de instrumento, leilões programados, halts, circuit breaker e fechamento (RN-SES-*, RN-HLT-*, RN-CB-*, RN-AUC-001..003, RN-FCH-*, RN-SBX-*).
- `order-management`: OMS com tipos, validades, validações, máquina de estados, alteração/cancelamento, condicionais, compostas e EOD (RN-ORD-*, RN-STP-*, RN-TRL-*, RN-ALT-*, RN-CAN-*, RN-CMP-*, RN-OCO-*, RN-BRK-*, RN-ICE-*, RN-VAL-*, RN-FLX-*).
- `matching-engine`: livro por instrumento, matching preço-tempo, FOK, STP, leilões, túneis, journal, snapshots, recuperação e trade bust (RN-ME-*, RN-AUC-010..033, RN-SLF-*, RN-REC-*, RN-BST-*).
- `simulated-market-maker`: cotações do FMS, recotação, estoque, comportamento por fase e kill switch (RN-SMM-*).
- `risk-margin`: holds, poder de compra, quantidade disponível, pré-trade, day trade, margem, venda a descoberto, monitoramento, chamada de margem e zeragem (RN-RSK-*, RN-HLD-*, RN-BP-*, RN-QD-*, RN-DT-*, RN-SHT-*, RN-MON-*, RN-MC-*, RN-LIQ-F-*, RN-PTC-*).
- `securities-lending`: ofertas, contratos, aluguel automático, remuneração, recall e renovação (RN-BTC-*).
- `clearing-settlement`: alocação, classificação day trade/swing, custos, nota de corretagem, liquidação D+2 e recompra compulsória (RN-CLR-*, RN-NTC-*, RN-LQA-*, RN-FEE-*).
- `custody-portfolio`: posições, movimentos em partidas dobradas, preço médio, resultado, carteira, TWR e transferência de custódia (RN-CST-*, RN-PM-*, RN-TRF-*, RN-RNT-*, RN-EXC-*).
- `corporate-actions`: captura, confirmação, direitos, aplicação em ações, proventos em dinheiro e frações (RN-CA-*).
- `income-tax`: apuração mensal, prejuízos, IRRF, DARF simulado e relatório anual (RN-IR-*, RN-DARF-*, RN-ANU-*).
- `notifications-alerts`: catálogo de notificações, preferências, entrega por canal, alertas de preço e watchlists (RN-NOT-G-*, RN-ALR-*, RN-WL-*).
- `reports-documents`: geração de documentos PDF/CSV/JSON, jobs assíncronos, links assinados, versões e retenção (RN-REL-*).
- `backoffice-approvals`: papéis do backoffice, maker-checker genérico e visão de suporte com mascaramento (RN-BO-*, RN-MC-BO-*, RN-SUP-*).
- `audit-trail`: trilha append-only encadeada por hash, ancoragem diária e consulta auditada (RN-AUD-*, RN-AUD-BO-*).
- `integrity-reconciliation`: reconciliações INV-01..08 como rotina e como teste, com alertas críticos (INV-*, RN-REC-004, RN-QA-010, RNF-030).
- `data-privacy`: criptografia de campo, hash com chave, pedidos do titular, exportação, anonimização e retenção (RN-LGPD-*, RN-DB-031, RN-RET-*).

### Modified Capabilities

Nenhuma. O projeto ainda não tem specs em `openspec/specs/`.

## Impact

- **Código**: cria o monorepo inteiro (`apps/`, `packages/`, `contracts/`, `scenarios/`, `infra/`, `docs/`). Nada existente é alterado; o repositório tem só `README.md` e o link `broker-docs`.
- **Dependências**: Node.js 24, pnpm, Turborepo, TypeScript, Express 5, `pg` + Kysely, `decimal.js`, `rabbitmq-stream-js-client` + `amqplib`, Ajv, `jose`, `argon2`, OpenTelemetry SDK, pino, Vitest, fast-check, Testcontainers. As versões exatas são fixadas na Fase 0.
- **Infraestrutura (Docker)**: PostgreSQL 17, RabbitMQ 4 (plugins stream e management), Valkey, MinIO, Mailpit, `grafana/otel-lgtm` e Traefik (TLS local).
- **Externo**: brapi.dev (só `market-data-service`, com fixtures/replay por padrão no ambiente local, RN-BRP-095).
- **Documentação**: `docs/mapeamento-tecnologico.md` (exigido por RN-BE-082), README e runbook por serviço.
- **Rastreabilidade**: cada requisito das specs cita os IDs de origem em `broker-docs`. Se a implementação divergir das regras, o conflito é registrado e não resolvido em silêncio.
