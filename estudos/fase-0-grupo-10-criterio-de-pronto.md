# Fase 0, grupo 10 — Critério de pronto

> Tarefas 10.1 e 10.2 de `openspec/changes/implementation-roadmap/tasks.md`. É o fechamento da Fase 0: "cada fase é entregue e validada pelo seu critério de pronto antes da seguinte" (design, Plano de migração).

## O que o critério de pronto prova

A Fase 0 não entrega funcionalidade de corretora. Ela entrega a **fundação** sobre a qual os ~25 serviços vão ser construídos. O critério de pronto responde a duas perguntas:

1. **As peças funcionam juntas?** Um serviço montado só com as bibliotecas da plataforma recebe uma requisição, grava e publica na mesma transação, consome o evento sem efeito duplicado, e tudo aparece num único trace (10.1).
2. **Outra pessoa consegue rodar?** Alguém com uma máquina limpa sobe o ambiente seguindo só um documento (10.2).

## 10.1 — O serviço de exemplo

A tarefa pedia um `apps/sample-service`. O `example-service`, reescrito sobre o service-kit no grupo 6, já fazia exatamente isso, e ficou decidido manter o nome e ajustar o texto da tarefa, em vez de renomear pasta, database, segredos, contrato e evento (`example.pinged`). A renomeação do evento ainda exigiria liberar a remoção da v1 no check de compatibilidade do grupo 7.

O caminho que o critério verifica:

```
POST /v1/pings
  └─ transação: INSERT ping + INSERT outbox_event          (mesma transação, ADR-0008)
       └─ relay: LISTEN/NOTIFY → publica no super stream → marca published_at
            └─ consumidor (SAC): processa → UPDATE ping + INSERT processed_event + offset
                                  (mesma transação do efeito: a inbox)
```

O teste E2E `apps/example-service/test/e2e/grafana-trace.e2e.ts` (do grupo 6) já verificava o trace no Tempo, consultado **pelo Grafana**. O span do consumidor descende do span HTTP. Para o critério de pronto, ele passou a verificar também os dois lados que o nome da tarefa cita:

- **outbox**: a linha do evento em `outbox_event` tem `published_at`, ou seja, o relay publicou;
- **inbox**: `processed_event` tem o `eventId` com o consumidor `example.ping-processor`. É esse registro, gravado na transação do efeito, que faz uma entrega repetida ser ignorada (a duplicata em si é testada no `@broker/messaging`, grupo 5).

O `eventId` do envelope é o `id` da linha da outbox. É por isso que o teste liga as duas tabelas sem precisar ler a mensagem do RabbitMQ.

## 10.2 — Primeiros passos

`docs/primeiros-passos.md` cobre os pré-requisitos, a instalação, o `pnpm env:up`, a confiança na CA do mkcert, as URLs e os problemas comuns.

Duas coisas que só ficaram claras ao escrever o guia:

- **O mkcert no host é opcional.** O certificado é gerado por um contêiner (`infra/mkcert`), então o host só precisa do mkcert para instalar a CA no sistema (`CAROOT=infra/certs/ca mkcert -install`). Sem ele, a CA é importada à mão no navegador (no WSL, com `certutil.exe` para o Windows).
- **Não precisa mexer no `/etc/hosts`.** Navegadores e o curl resolvem `*.localhost` para `127.0.0.1` sozinhos (RFC 6761). Ferramentas que usam o resolvedor do sistema (`getent`) não resolvem, mas nenhum passo do guia depende delas.

### Verificação numa clone limpa

O guia foi seguido num clone novo, sem `node_modules`, segredos, certificados ou hook. Para não tocar nos dados do ambiente principal, o ambiente principal foi parado (as portas são as mesmas) e o clone rodou com `COMPOSE_PROJECT_NAME=broker-guia`. Assim os volumes do clone começaram vazios e foram apagados no fim.

| Passo do guia                      | Resultado no clone                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `corepack enable` + `pnpm install` | instalou e ligou o hook (`core.hooksPath = .githooks`)                             |
| `pnpm env:up`                      | segredos e CA novos gerados; `ambiente 'infra' pronto.` em 47 s (imagens em cache) |
| URLs                               | 200 em bank, kyc, sms, mail, Grafana, RabbitMQ e MinIO, com a CA nova              |
| `pnpm env:up full` + `/info`       | `example-service`, versão `0.0.0` e o commit da imagem                             |
| ping + Grafana                     | trace de 19 spans no Tempo: HTTP, `INSERT` na outbox, `process example.pinged`     |
| `pnpm test:infra`                  | 4 arquivos, 15 testes passando                                                     |

O que a verificação **não** cobriu: o primeiro download das imagens (estavam em cache, então numa máquina realmente nova o `env:up` demora mais), o `pnpm test` completo no clone (o conteúdo é o mesmo do repositório, onde ele roda no CI), e a importação da CA no Windows (comando documentado, não executado).

## A Fase 0 em uma tabela

| Grupo | Entrega                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------- |
| 1     | monorepo pnpm + Turborepo, TypeScript strict, ESLint com fronteiras de domínio, Vitest            |
| 2     | Docker: Postgres com usuário por serviço, RabbitMQ streams, Valkey, MinIO, Mailpit, LGTM, Traefik |
| 3     | `Money`/`Price`/`Quantity`, rateio, CPF, IDs, relógio virtual, calendário B3                      |
| 4     | Kysely, migrações, outbox/inbox/saga, append-only, criptografia de campo, eleição de líder        |
| 5     | envelope, outbox relay, consumidor com inbox, retentativas, DLQ, bloqueio por chave, jobs         |
| 6     | service kit: config, Problem Details, idempotência, logs, OpenTelemetry, auth, RPC, sagas, flags  |
| 7     | contratos (JSON Schema, AsyncAPI, OpenAPI) com compatibilidade, builders, golden master           |
| 8     | simuladores PIX, KYC e SMS/push, webhooks assinados, Mailpit com lista de permissão               |
| 9     | CI com Turborepo, SAST/SCA/segredos, SBOM e assinatura keyless, Conventional Commits, release     |
| 10    | critério de pronto: serviço de exemplo de ponta a ponta e guia de primeiros passos                |

A Fase 1 começa pelo `scheduler-service` (grupo 11), o primeiro serviço de domínio de verdade.
