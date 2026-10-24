# Primeiros passos

Do clone ao ambiente local rodando: infraestrutura, simuladores e serviço de exemplo, com HTTPS em
`*.broker.localhost`. Na primeira vez, contando downloads de imagens, leva uns 10 minutos.

## 1. Pré-requisitos

| Ferramenta    | Versão                                | Para quê                                                                      |
| ------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| Docker Engine | 24+ com **Compose v2.20+**            | todo o ambiente (`docker compose version` precisa responder)                  |
| Node.js       | **24** (ver `.nvmrc`)                 | scripts, testes e serviços fora do contêiner                                  |
| pnpm          | 12, via **corepack** (vem com o Node) | o gerenciador do monorepo; a versão vem do `packageManager` do `package.json` |
| Git           | qualquer recente                      | o hook de commit e o versionamento dependem dele                              |
| mkcert        | opcional                              | só para o sistema e o navegador confiarem na CA local (passo 4)               |

Memória para o Docker: cerca de **8 GB** para o perfil `infra` e **16 GB** para o `full`. As portas
usadas no host são 80, 443, 5432, 5672, 5552, 15672, 6380, 9000, 9001, 1025, 8025, 3000, 4317 e
4318 (veja [Portas ocupadas](#portas-ocupadas) para trocar alguma).

> **Windows**: use o WSL 2 com o Docker Desktop (integração WSL ligada) ou o Docker Engine dentro do
> WSL, e clone o repositório **dentro** do sistema de arquivos do Linux (`~/...`, não `/mnt/c/...`).

## 2. Clonar e instalar

```bash
git clone git@github.com:steglich/broker-node.git
cd broker-node
corepack enable
pnpm install
```

O `pnpm install` também liga o hook `commit-msg`, que valida a convenção de commits
([CONTRIBUTING.md](../CONTRIBUTING.md)).

## 3. Subir o ambiente

```bash
pnpm env:up
```

O comando:

1. gera os segredos em `infra/secrets/` (simulando o cofre; ficam fora do git);
2. gera a CA local e o certificado de `*.broker.localhost` com **mkcert**, num contêiner, em `infra/certs/`;
3. faz o build das imagens e sobe tudo com `docker compose`;
4. espera cada contêiner ficar `healthy` (e as migrações one-shot terminarem com sucesso);
5. garante um database e dois usuários (`<svc>_app` e `<svc>_migrator`) para cada serviço do catálogo.

Ele termina com `ambiente 'infra' pronto.`. Os perfis:

| Comando            | O que sobe                                                          |
| ------------------ | ------------------------------------------------------------------- |
| `pnpm env:up`      | `infra`: infraestrutura e simuladores externos (PIX, KYC, SMS/push) |
| `pnpm env:up core` | + serviços do núcleo (a partir da Fase 1)                           |
| `pnpm env:up full` | + todos os serviços, inclusive o `example-service`                  |

## 4. Confiar no certificado local

O Traefik serve HTTPS com um certificado assinado pela CA em `infra/certs/ca/rootCA.pem`. Sem confiar
nela, o navegador mostra um aviso.

- **Com mkcert no host** (Linux/macOS): `CAROOT=infra/certs/ca mkcert -install`
- **Firefox**: Configurações → Privacidade e segurança → Certificados → Importar `rootCA.pem`.
- **Windows (WSL)**: no WSL, `certutil.exe -user -addstore Root "$(wslpath -w infra/certs/ca/rootCA.pem)"`;
  vale para Edge e Chrome do Windows.
- **curl**: `curl --cacert infra/certs/ca/rootCA.pem https://...`

`*.broker.localhost` resolve para `127.0.0.1` sozinho no navegador e no curl: não precisa mexer no `/etc/hosts`.

## 5. URLs

| O quê                             | Endereço                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| Banco Simulado (PIX)              | https://bank.broker.localhost/ui                                                         |
| Provedor de KYC simulado          | https://kyc.broker.localhost/ui                                                          |
| SMS e push (`message-sink`)       | https://sms.broker.localhost/ui                                                          |
| E-mail (Mailpit)                  | https://mail.broker.localhost                                                            |
| Grafana (traces, logs, métricas)  | http://localhost:3000 (usuário `admin`, senha em `infra/secrets/grafana_admin_password`) |
| RabbitMQ                          | http://localhost:15672 (usuário `broker`, senha em `infra/secrets/rabbitmq_password`)    |
| MinIO                             | http://localhost:9001 (usuário `broker`, senha em `infra/secrets/minio_root_password`)   |
| `example-service` (perfil `full`) | https://example.broker.localhost/info                                                    |

As credenciais de PostgreSQL e Valkey estão no [README da infraestrutura](../infra/README.md#endereços).

## 6. Conferir que funciona

```bash
# o serviço de exemplo responde com versão e commit
pnpm env:up full
curl --cacert infra/certs/ca/rootCA.pem https://example.broker.localhost/info

# um ping atravessa HTTP → outbox → RabbitMQ → consumidor
curl --cacert infra/certs/ca/rootCA.pem -X POST https://example.broker.localhost/v1/pings
```

O trace do ping aparece no Grafana: **Explore → Tempo → Search**, serviço `example-service`.
Os spans de HTTP, do `INSERT` na outbox e do consumidor (`process example.pinged`) estão no mesmo trace.

Os testes:

```bash
pnpm test         # unitários, integração e componente (sobem contêineres próprios com Testcontainers)
pnpm test:infra   # verificações contra o ambiente rodando: isolamento do Postgres, TLS, MinIO, trace no Grafana
pnpm ci:local     # o mesmo pipeline do CI, na sua máquina
```

## 7. Dia a dia

| Comando                   | O quê                                                  |
| ------------------------- | ------------------------------------------------------ |
| `pnpm env:ps`             | estado dos contêineres                                 |
| `pnpm env:logs [serviço]` | logs (ex.: `pnpm env:logs pix-simulator`)              |
| `pnpm env:down`           | para tudo e mantém os dados                            |
| `pnpm env:down --volumes` | para tudo e **apaga** bancos, filas e buckets          |
| `pnpm contracts:generate` | regera JSON Schema, AsyncAPI e OpenAPI de `contracts/` |
| `pnpm scenarios`          | roda os cenários golden master                         |
| `pnpm release`            | plano de versões e changelog por serviço               |

A documentação de cada parte: [infraestrutura](../infra/README.md), [mapeamento tecnológico](mapeamento-tecnologico.md),
[contratos](../contracts/README.md), [cenários](../scenarios/README.md), simuladores
([PIX](../apps/pix-simulator/README.md), [KYC](../apps/kyc-simulator/README.md), [SMS/push](../apps/message-sink/README.md))
e as notas de estudo de cada grupo da Fase 0 em [`estudos/`](../estudos/).

## Problemas comuns

### Portas ocupadas

Se o `docker compose` reclamar de porta em uso (um PostgreSQL local, por exemplo), troque a porta do
host por variável e suba de novo: `POSTGRES_PORT=5433 pnpm env:up`. Há uma para cada porta:
`POSTGRES_PORT`, `RABBITMQ_PORT`, `RABBITMQ_STREAM_PORT`, `RABBITMQ_UI_PORT`, `VALKEY_PORT`,
`MINIO_PORT`, `MINIO_CONSOLE_PORT`, `MAILPIT_SMTP_PORT`, `MAILPIT_UI_PORT`, `GRAFANA_PORT`,
`OTLP_GRPC_PORT`, `OTLP_HTTP_PORT`, `HTTP_PORT` e `HTTPS_PORT`.

### `env:up` não termina ou um contêiner falha

O comando diz qual serviço não ficou pronto. Veja o motivo com `pnpm env:logs <serviço>`. Uma queda
de conexão com o BuildKit durante o build (`connection reset by peer`) costuma ser falta de memória
do Docker: rode `pnpm env:up` de novo ou aumente a memória.

### Navegador recusa o certificado

A CA não foi importada (passo 4), ou foi gerada de novo: apagar `infra/certs/` cria uma CA nova, que
precisa ser importada outra vez.

### Senhas e dados

Os segredos são gerados só uma vez. Para recomeçar do zero: `pnpm env:down --volumes`, apague
`infra/secrets/` (menos o `README.md`) e rode `pnpm env:up`.
