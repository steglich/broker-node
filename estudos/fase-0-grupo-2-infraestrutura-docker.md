# Fase 0, grupo 2 — Infraestrutura em Docker

> Tarefas 2.1 a 2.6 de `openspec/changes/implementation-roadmap/tasks.md`. Runbook rápido em `infra/README.md`.

## Visão geral

O grupo 1 montou o repositório. O grupo 2 monta o **ambiente onde os serviços vão rodar**: banco, barramento de mensagens, cache, armazenamento de arquivos, e-mail, observabilidade e a "porta de entrada" HTTPS. Tudo em Docker, para que a máquina só precise de Docker, Node e pnpm (a spec `local-environment` exige isso: RN-ENV-030).

Também cria o **molde de um serviço**: um Dockerfile único e o padrão "migração roda antes do serviço", testados com um serviço de exemplo.

```
                    ┌──────────── Traefik (80/443, TLS mkcert) ─────────────┐
navegador / curl ──►│ api.  ws.  bank.  kyc.  mail.  *.broker.localhost      │
                    └───────┬──────────────────────────────────────┬────────┘
                            ▼                                      ▼
                     (serviços, Fase 1+)                        Mailpit
                            │
     ┌──────────┬───────────┼───────────┬───────────┬──────────────┐
     ▼          ▼           ▼           ▼           ▼              ▼
 PostgreSQL  RabbitMQ     Valkey      MinIO      otel-lgtm      Mailpit
 (1 db por   (streams +   (cache,     (S3:       (traces,       (SMTP de
  serviço)    filas)      sem disco)  buckets)   métricas,logs)  captura)
```

---

## 2.1 — O `compose.yml`

Arquivo: `infra/compose/compose.yml`. O Docker Compose descreve vários contêineres, as redes, volumes e segredos entre eles, e sobe tudo com um comando.

### Os componentes e o papel de cada um

| Contêiner    | Imagem                                     | Para que serve no broker                                                                 |
| ------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `postgres`   | `postgres:17.11-alpine`                    | banco de dados; um database por serviço (D4)                                             |
| `rabbitmq`   | `rabbitmq:4.3.6-management-alpine`         | barramento de eventos (streams) e filas de retry/DLQ/jobs (D6)                           |
| `valkey`     | `valkey/valkey:8.1.10-alpine`              | cache: rate limit, revogação de tokens, idempotência rápida (D16). Fork aberto do Redis  |
| `minio`      | `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` | armazenamento de objetos compatível com S3: documentos, relatórios, âncoras de auditoria |
| `mailpit`    | `axllent/mailpit:v1.31.6`                  | servidor SMTP falso: captura e-mails para você ver numa UI, sem enviar nada de verdade   |
| `lgtm`       | `grafana/otel-lgtm:0.37.0`                 | observabilidade "tudo em um": coletor OpenTelemetry, Tempo, Prometheus, Loki e Grafana   |
| `traefik`    | `traefik:v3.7.15`                          | proxy reverso de borda: termina HTTPS e roteia por nome de host (D9)                     |
| `certs`      | construída de `infra/mkcert`               | one-shot: gera o certificado TLS local e termina                                         |
| `minio-init` | mesma do MinIO                             | one-shot: cria os buckets e termina                                                      |

**Por que versões fixas** (`17.11-alpine` e não `latest`): `latest` muda sem aviso. Fixar garante que hoje e daqui a seis meses o ambiente sobe igual: é a mesma ideia de reprodutibilidade do projeto inteiro. A tabela de versões fica em `docs/mapeamento-tecnologico.md`.

### Healthchecks

"Contêiner rodando" não quer dizer "pronto para uso". O Postgres, por exemplo, leva alguns segundos para aceitar conexões depois de iniciar. Um **healthcheck** é um comando que o Docker roda periodicamente dentro do contêiner; o estado vira `healthy` quando ele passa.

| Contêiner | Teste de saúde                                                           |
| --------- | ------------------------------------------------------------------------ |
| postgres  | `pg_isready`                                                             |
| rabbitmq  | porta de stream (5552) ouvindo + `check_running`                         |
| valkey    | `valkey-cli ping` responde `PONG` (com senha)                            |
| minio     | `curl /minio/health/live`                                                |
| mailpit   | `mailpit readyz`                                                         |
| lgtm      | o script do lgtm cria `/tmp/ready` quando todos os componentes respondem |
| traefik   | `traefik healthcheck --ping`                                             |

Para escrever cada um, foi preciso olhar dentro das imagens: a do MinIO tem `curl` mas não tem `grep`; a do lgtm não tem `which`, mas cria um arquivo de "pronto". Cada imagem é um mundo.

### RabbitMQ: plugins de stream

O design (D6) usa **streams** do RabbitMQ (um log particionado e relível, parecido com Kafka). Isso exige plugins, ligados em `infra/rabbitmq/enabled_plugins`:

```
[rabbitmq_management, rabbitmq_prometheus, rabbitmq_stream, rabbitmq_stream_management].
```

- `rabbitmq_stream`: o protocolo de streams, na porta 5552;
- `rabbitmq_stream_management`: os streams aparecem na UI;
- `rabbitmq_management`: a UI web (porta 15672);
- `rabbitmq_prometheus`: métricas para a observabilidade.

### O problema do `--wait` e a solução

O plano era subir com `docker compose up --wait`, que espera tudo ficar saudável. Mas os contêineres **one-shot** (`certs`, `minio-init`) fazem o trabalho e terminam. O `--wait` interpreta "terminou" como falha, mesmo com código de saída 0.

A solução foi escrever a espera no `infra/scripts/env.mjs` (função `waitReady`), que consulta `docker compose ps --format json` a cada 2 segundos com esta regra:

- contêiner com healthcheck → precisa estar `healthy`;
- contêiner que terminou → precisa ter código de saída 0 (senão, falha e mostra qual);
- os demais → precisam estar `running`;
- limite de 5 minutos.

---

## 2.2 — Um database e duas credenciais por serviço

### O problema que isso resolve

Em microsserviços, cada serviço é **dono dos seus dados** (RN-DB-001). Se o OMS pudesse ler a tabela do Ledger diretamente, os dois ficariam acoplados: o Ledger não poderia mudar seu esquema sem quebrar o OMS. A única forma de um serviço saber algo do outro é por **eventos** ou pelas exceções síncronas previstas.

Em produção isso seria um servidor de banco por serviço. Localmente, para caber na máquina, é **uma instância Postgres com um database por serviço**. O isolamento vem das permissões, e foi isso que a tarefa construiu.

### O catálogo

`infra/postgres/services.txt` lista os serviços com banco: `scheduler`, `audit`, `identity`, `ledger`, `oms`, `risk`, `matching_engine`... (25 nomes, incluindo os simuladores e o `example`). Os nomes usam `_` porque viram identificadores SQL.

### O que o script cria para cada serviço

Arquivo: `infra/postgres/init/01-services.sh`. Para o serviço `ledger`:

| Objeto            | O que pode                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| database `ledger` | ninguém conecta, exceto os dois usuários abaixo (`REVOKE ALL ... FROM PUBLIC`)                    |
| `ledger_migrator` | dono do database e do schema `public`: cria, altera e apaga tabelas (DDL). Usado só nas migrações |
| `ledger_app`      | só `SELECT/INSERT/UPDATE/DELETE` (DML). É o usuário com que o serviço roda                        |

**Por que dois usuários (RN-DB-032)?** Princípio do menor privilégio. Se o serviço tiver uma falha de injeção de SQL, o atacante usa a credencial do serviço (`_app`), que não consegue apagar tabelas nem mudar o esquema. Mudar o esquema só acontece no passo de migração, com outra credencial.

Os pontos técnicos mais interessantes:

- **`ALTER DEFAULT PRIVILEGES`**: as tabelas ainda não existem quando o script roda (serão criadas pelas migrações, mais tarde). Este comando diz: "toda tabela que o `ledger_migrator` criar no futuro já dá DML ao `ledger_app`". Sem isso, cada migração teria de lembrar de dar `GRANT`.
- **`\gexec` do psql**: `CREATE DATABASE` não pode ficar dentro de um bloco `DO`. O truque é um `SELECT` que **gera o texto do comando** só quando o objeto não existe, e o `\gexec` executa o resultado. Isso deixa o script **idempotente** (rodar duas vezes não dá erro).
- **`format('%I', ...)` e `%L`**: `%I` escapa identificadores e `%L` escapa literais (senhas). É a forma segura de montar SQL dinâmico, evitando injeção.
- **`ALTER ROLE ... PASSWORD`** a cada execução: sincroniza a senha com o arquivo de segredo.

### Por que roda a cada `env:up`

A imagem oficial do Postgres só executa os scripts de `docker-entrypoint-initdb.d` **na primeira vez**, com o volume vazio. Se um serviço novo entrar no catálogo depois, ele não ganharia database. Por isso o `env:up` roda o script de novo depois de subir (`docker compose exec postgres bash .../01-services.sh`). Como é idempotente, só cria o que falta.

### Como foi verificado

`infra/tests/postgres-isolation.test.ts` conecta de verdade no Postgres e testa:

1. `oms_app` conecta no database `oms`;
2. `oms_app` e `oms_migrator` **não conectam** no `ledger` → `permission denied for database "ledger"`;
3. `ledger_app` **não executa** `CREATE TABLE` → `permission denied for schema public`;
4. `ledger_migrator` cria uma tabela, `ledger_app` consegue inserir e ler nela, mas **não consegue** apagá-la (`must be owner`).

---

## 2.3 — Traefik e HTTPS local

### O que é o Traefik aqui

Um **proxy reverso**: recebe todas as requisições nas portas 80/443 e decide para qual contêiner encaminhar, pelo nome do host. `api.broker.localhost` vai para o api-gateway, `ws.` para o gateway de tempo real, `mail.` para o Mailpit, e assim por diante.

Configuração em dois arquivos:

- `infra/traefik/traefik.yml` (estática): os entrypoints `web` (80) e `websecure` (443), o redirecionamento HTTP→HTTPS e os provedores;
- `infra/traefik/dynamic/tls.yml`: qual certificado usar.

O **provedor docker** faz o Traefik ler os **labels** dos contêineres. O Mailpit, por exemplo, declara:

```yaml
traefik.http.routers.mail.rule: Host(`mail.broker.localhost`)
traefik.http.services.mail.loadbalancer.server.port: '8025'
```

Assim, cada serviço novo se registra na borda só com labels, sem mexer na configuração do Traefik. `exposedByDefault: false` garante que só aparece quem pedir.

### Por que `*.broker.localhost`

O domínio `.localhost` é reservado e sempre aponta para a própria máquina. Não precisa editar `/etc/hosts`.

### mkcert dentro de um contêiner

HTTPS precisa de certificado. O **mkcert** cria uma **autoridade certificadora (CA) local** e emite certificados assinados por ela. Se o navegador confiar na CA, o cadeado fica verde.

O mkcert não estava instalado, e a spec pede que nada além de Docker seja exigido. Solução: `infra/mkcert/Dockerfile` cria uma imagem Alpine com o binário do mkcert baixado do GitHub, com **verificação do SHA-256** (se o arquivo baixado for diferente do esperado, o build falha; é proteção contra adulteração). O serviço `certs` roda essa imagem uma vez e grava em `infra/certs/` (fora do git):

- `ca/rootCA.pem`: a CA. **Importe no Windows/navegador** para confiar;
- `broker.localhost.pem` e `-key.pem`: o certificado de `*.broker.localhost`.

O Traefik tem `depends_on: certs: service_completed_successfully`: só sobe depois que o certificado existe.

### Como foi verificado

`infra/tests/traefik-tls.test.ts`:

- para `api`, `ws`, `bank`, `kyc` e `mail`: `http://...` responde redirecionamento permanente para `https://...`;
- `https://mail.broker.localhost` responde 200 **validando o certificado contra a CA local**. Se o certificado fosse inválido, a conexão TLS falharia.

**Detalhe descoberto no teste:** com `curl -I` (método HEAD) o Traefik respondeu **308**, mas o teste em Node (GET) recebeu **301**. O Traefik usa 301 para GET e 308 para os outros métodos. Ambos são "permanente"; a diferença é que o 308 obriga o cliente a repetir o mesmo método e corpo (importante para POST). O teste aceita os dois.

`api.` hoje responde 404: o api-gateway ainda não existe (Fase 1). O redirecionamento funciona mesmo assim, porque ele é do entrypoint, não da rota.

---

## 2.4 — Dockerfile único e migração one-shot

### Um Dockerfile para todos os serviços

Arquivo: `infra/docker/Dockerfile`. Com ~25 serviços, ter 25 Dockerfiles quase iguais seria manutenção dobrada. Há um só, parametrizado:

```bash
docker build -f infra/docker/Dockerfile --build-arg SERVICE=@broker/example-service .
```

É **multi-stage**: vários `FROM` em sequência, e só o último vira a imagem final.

| Estágio   | O que faz                                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`    | `node:24-slim` + `corepack enable` (traz o pnpm na versão do `packageManager`)                                                                  |
| `build`   | copia o monorepo, `pnpm install --frozen-lockfile`, compila o serviço **e suas dependências** (`--filter="${SERVICE}..."`) e roda `pnpm deploy` |
| `runtime` | imagem limpa `node:24-slim` com só `package.json`, `node_modules` de produção e `dist/`; roda como `USER node`                                  |

Conceitos importantes:

- **`pnpm deploy --filter <svc> --prod /out`**: num monorepo, o `node_modules` tem tudo de todos. O `deploy` monta uma pasta isolada só com o que **aquele** serviço precisa em produção, inclusive copiando os pacotes `@broker/*` do workspace. Exigiu `injectWorkspacePackages: true` no `pnpm-workspace.yaml`.
- **`--frozen-lockfile`**: falha se o `pnpm-lock.yaml` não bater com os `package.json`. Garante que a imagem usa exatamente as versões travadas.
- **`--mount=type=cache`**: o Docker guarda o store do pnpm entre builds; o segundo build não baixa tudo de novo.
- **Usuário não-root**: a imagem oficial do Node já tem o usuário `node` (uid 1000). Se alguém explorar o processo, não é root dentro do contêiner.
- **`.dockerignore`**: tira do contexto de build `node_modules`, `dist`, `.git`, `broker-docs`, segredos e certificados. Builds mais rápidos e nenhum segredo dentro de imagem (RN-BE-060).

O tamanho final ficou ~332 MB, a maior parte é a própria imagem do Node.

### O padrão de migração one-shot

Cada serviço vira **dois** contêineres no compose, a partir da mesma imagem:

```
example-migrate  → node dist/migrate.js  (usuário example_migrator) → termina
       │  depends_on: service_completed_successfully
       ▼
example-service  → node dist/main.js     (usuário example_app)      → fica rodando
```

Por que separar:

- o serviço **nunca** sobe com o banco num esquema antigo (RN-DB-020/021);
- a credencial de DDL só existe no contêiner de migração; o serviço não a recebe;
- com várias instâncias do serviço, a migração roda uma vez, não uma por instância.

### O serviço de exemplo

`apps/example-service` existe só para provar o padrão (e sai quando houver serviços reais):

- `src/db.ts`: conecta no Postgres lendo a senha do arquivo indicado por `DB_PASSWORD_FILE` (o Docker secret);
- `src/migrate.ts`: cria a tabela `migration_marker` e grava um carimbo;
- `src/main.ts`: servidor HTTP mínimo com `/health`, que responde `UP` **só se a tabela da migração existir**.

### Como foi verificado

Com `pnpm env:up full`:

- `example-migrate` terminou com código 0 às 13:09:34.83;
- `example-service` iniciou às 13:09:35.29, depois da migração;
- `/health` respondeu `{"status":"UP","migratedAt":"..."}`;
- `id -un` dentro do contêiner deu `node`.

---

## 2.5 — Perfis, segredos, limites e comandos

### Perfis

O ambiente completo terá ~30 contêineres, pesado para subir sempre. Perfis do Compose escolhem o que sobe:

| Perfil  | Sobe                                            | Uso                                                      |
| ------- | ----------------------------------------------- | -------------------------------------------------------- |
| `infra` | só infraestrutura (contêineres **sem** perfil)  | desenvolver um serviço rodando fora do Docker, no editor |
| `core`  | infra + serviços do núcleo (`profiles: [core]`) | fluxo principal: conta, ordem, motor                     |
| `full`  | infra + core + todos (`profiles: [full]`)       | tudo                                                     |

Truque usado: contêineres sem `profiles` sobem **sempre**. Por isso a infraestrutura não tem perfil, e `env:up infra` simplesmente não ativa nenhum.

Verificação: depois de `env:down`, `env:up core` subiu só a infraestrutura; o `example-service` (perfil `full`) ficou de fora. Ressalva: ainda não há serviços `core` (chegam na Fase 1), então hoje `core` = `infra`.

### Docker secrets (o "cofre" local)

Senhas não podem ficar no código, na imagem nem em variáveis de ambiente visíveis com `docker inspect` (RN-BE-060). O design (D18) usa **Docker secrets**: cada segredo é um arquivo, montado dentro do contêiner em `/run/secrets/<nome>`.

- `infra/scripts/secrets.mjs` gera senhas aleatórias (24 bytes em hex) em `infra/secrets/`. É **idempotente**: não troca o que já existe.
- O `.gitignore` ignora `infra/secrets/*`, exceto o `README.md`. Conferido: nenhum segredo aparece no `git status`.
- Cada imagem lê o segredo de um jeito:
  - Postgres: `POSTGRES_PASSWORD_FILE` (suporte nativo);
  - MinIO: `MINIO_ROOT_PASSWORD_FILE` (nativo);
  - Grafana: `GF_SECURITY_ADMIN_PASSWORD__FILE` (nativo);
  - RabbitMQ: **não** tem suporte nativo. Um `entrypoint` em shell lê o arquivo e escreve `default_pass = ...` num `conf.d` antes de iniciar o servidor;
  - Valkey: idem, passa `--requirepass "$(cat /run/secrets/valkey_password)"`.
- No compose, `$$` é o escape de `$`: sem isso, o Compose tentaria substituir a variável na hora de ler o arquivo, e não dentro do contêiner.

### Limites de memória

`deploy.resources.limits.memory` em cada contêiner (Postgres 1 GB, RabbitMQ 1 GB, lgtm 1,5 GB, MinIO 512 MB, os pequenos 256 MB). Evita que um contêiner consuma a RAM toda, e a soma precisa caber em ~16 GB no perfil `full` (D22). Conferido com `docker stats`: o lgtm usava ~560 MB de 1,5 GB, o RabbitMQ ~128 MB.

O bloco `x-limits: &small` com `<<: *small` é uma **âncora YAML**: define o limite pequeno uma vez e reaproveita.

### Os comandos `env:*`

Implementados em `infra/scripts/env.mjs`:

| Comando                     | O que faz                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm env:up [perfil]`      | gera segredos → `compose up -d --build` → espera ficar pronto → roda o init do Postgres |
| `pnpm env:down [--volumes]` | derruba tudo; `--volumes` apaga os dados                                                |
| `pnpm env:logs [serviço]`   | logs em tempo real                                                                      |
| `pnpm env:ps`               | estado dos contêineres                                                                  |
| `pnpm env:seed`             | roda o script `seed` de cada pacote que tiver um (por enquanto, nenhum)                 |

### Portas configuráveis e o conflito da 6379

Ao checar as portas, a 6379 estava ocupada pelo contêiner `meu-redis` de outro projeto. Em vez de mexer nele, o Valkey é exposto na **6380** do host (dentro da rede Docker continua 6379). Todas as portas usam `${VARIAVEL:-padrão}` no compose, então dá para trocar sem editar o arquivo (`POSTGRES_PORT=5433 pnpm env:up`).

---

## 2.6 — MinIO e Valkey

### Buckets do MinIO

`infra/minio/init.sh`, rodado pelo one-shot `minio-init`:

| Bucket          | Uso                                    | Configuração especial                                   |
| --------------- | -------------------------------------- | ------------------------------------------------------- |
| `documents`     | documentos do onboarding (KYC)         | —                                                       |
| `reports`       | relatórios e notas gerados             | —                                                       |
| `brapi-raw`     | respostas brutas da brapi              | regra de ciclo de vida: expira em 30 dias               |
| `audit-anchors` | âncoras diárias da trilha de auditoria | **object lock** em modo COMPLIANCE, retenção de 10 anos |

### WORM e object lock

A trilha de auditoria (RN-AUD-002) é encadeada por hash: cada registro inclui o hash do anterior. Uma vez por dia, o hash do topo é "ancorado" num lugar que **ninguém consegue alterar**. Se alguém adulterar a trilha, o hash não bate com a âncora.

Esse lugar é o `audit-anchors`, com **WORM** (_write once, read many_):

- **versionamento**: um novo `PUT` na mesma chave não substitui o arquivo, cria **outra versão**;
- **object lock COMPLIANCE**: nenhuma versão pode ser alterada ou apagada até o fim da retenção, **nem pelo usuário raiz**. (O modo GOVERNANCE permitiria a um administrador com permissão especial burlar; o COMPLIANCE não.)

Uma sutileza: o S3 não **impede** um `PUT` na mesma chave. A garantia é que a versão original continua lá, intacta e não apagável. O teste reflete isso.

### Valkey sem persistência

O Valkey sobe com `--save '' --appendonly no`: sem snapshots (RDB) e sem log de escrita (AOF). É **cache**: a fonte da verdade é sempre o Postgres. Reiniciar o contêiner zera o conteúdo, e o sistema precisa funcionar assim (D16).

### Como foi verificado

`infra/tests/storage.test.ts`:

1. os 4 buckets existem;
2. no `audit-anchors`: grava uma âncora, grava de novo na mesma chave (nasce outra versão), lê a versão original e confirma o conteúdo intacto, tenta apagá-la e o MinIO recusa com **"WORM protected"**;
3. o Valkey responde `save` vazio e `appendonly no`.

Efeito colateral: cada execução deixa 2 objetos minúsculos em `audit-anchors/infra-test/` que **não podem** ser apagados por 10 anos. Somem só com `pnpm env:down --volumes`. É o WORM funcionando.

---

## Os testes de infraestrutura

São testes de verdade, contra o ambiente rodando, num projeto Vitest separado (`infra/vitest.config.ts`):

- `pnpm test` → testes unitários, **não precisam de Docker** (exclui o projeto `infra` com `--project "!infra"`);
- `pnpm test:infra` → os 13 testes contra o ambiente (precisa de `pnpm env:up` antes).

A separação importa: os unitários devem rodar em qualquer lugar e em segundos; os de infraestrutura dependem do ambiente.

---

## Problemas no caminho

1. **Imagem do MinIO sumiu.** `minio/minio` e `quay.io/minio/minio` não existem mais: a MinIO parou de publicar imagens da edição comunitária. Foram testadas alternativas; a escolhida foi `pgsty/minio` (build do código oficial, com tags versionadas, e já traz o cliente `mc`). A `cgr.dev/chainguard/minio` só é gratuita na tag `latest`, que não dá para fixar. Registrado em "Conflitos e simplificações" no mapeamento tecnológico.
2. **`--wait` do Compose** trata one-shot encerrado como falha → espera própria no `env.mjs`.
3. **Sem `grep` na imagem do MinIO.** O teste "a regra de expiração já existe?" usava `grep`; trocado por `case` do shell. Sem isso, cada `env:up` duplicaria a regra.
4. **Porta 6379 ocupada** pelo Redis de outro projeto → Valkey na 6380.
5. **301 × 308** no redirecionamento (explicado na 2.3).
6. **Lint dos scripts `.mjs`**: `process` e `console` não eram reconhecidos. A configuração ESLint compartilhada passou a declarar os globais do Node (`globals.node`), já que todo o código roda em Node.
7. **`sed` sem efeito**: tentei editar o `vitest.config.ts` com `sed`, mas o Prettier já tinha quebrado a linha em várias; a substituição não casou e o Vitest reclamou "No projects matched". Corrigido editando o arquivo diretamente. Lição: depois de formatar, não confie no formato antigo da linha.

---

## Para experimentar

Subir só a infraestrutura:

```bash
pnpm env:up infra
```

Ver o estado dos contêineres:

```bash
pnpm env:ps
```

Rodar os testes contra o ambiente:

```bash
pnpm test:infra
```

Tentar o acesso cruzado na mão (deve falhar com `permission denied`):

```bash
PGPASSWORD=$(cat infra/secrets/db/oms_app) psql -h localhost -U oms_app -d ledger
```

Ver o redirecionamento HTTP→HTTPS:

```bash
curl -sI http://api.broker.localhost
```

Subir com o serviço de exemplo e ver a migração antes do serviço:

```bash
pnpm env:up full
```

Abrir as UIs: RabbitMQ em http://localhost:15672 (usuário `broker`), MinIO em http://localhost:9001 (`broker`), Grafana em http://localhost:3000 (`admin`) e Mailpit em https://mail.broker.localhost. As senhas estão em `infra/secrets/`.

Derrubar (e apagar os dados):

```bash
pnpm env:down --volumes
```

O próximo grupo (3) é o domínio compartilhado: `Money`, `Price`, `Quantity`, CPF, IDs, relógio e calendário. É código puro, sem infraestrutura, e é onde a regra de determinismo do ESLint começa a trabalhar.
