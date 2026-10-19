# Infraestrutura local

Tudo roda em Docker; na máquina só são necessários Docker, Node 24 e pnpm (via corepack).

## Comandos

| Comando                           | O que faz                                                              |
| --------------------------------- | ---------------------------------------------------------------------- |
| `pnpm env:up [infra\|core\|full]` | gera segredos e certificados, sobe o perfil e espera tudo ficar pronto |
| `pnpm env:ps`                     | estado dos contêineres                                                 |
| `pnpm env:logs [serviço]`         | logs em tempo real                                                     |
| `pnpm env:down [--volumes]`       | derruba o ambiente (`--volumes` apaga bancos, filas e buckets)         |
| `pnpm env:seed`                   | roda o script `seed` de cada serviço (idempotente)                     |
| `pnpm test:infra`                 | testes de verificação contra o ambiente rodando                        |

Perfis: `infra` sobe só a infraestrutura (para rodar serviços fora do contêiner), `core` acrescenta os serviços do núcleo e `full` todos os serviços.

## Endereços

| Serviço                   | Endereço                                                    | Usuário                                   |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| PostgreSQL                | `localhost:5432`                                            | `postgres`, `<svc>_app`, `<svc>_migrator` |
| RabbitMQ (AMQP/stream/UI) | `localhost:5672` / `5552` / http://localhost:15672          | `broker`                                  |
| Valkey                    | `localhost:6380` (6380 para não colidir com um Redis local) | senha em `secrets/valkey_password`        |
| MinIO (S3/console)        | `localhost:9000` / http://localhost:9001                    | `broker`                                  |
| Mailpit                   | https://mail.broker.localhost ou http://localhost:8025      | —                                         |
| Grafana (LGTM)            | http://localhost:3000; OTLP em `4317`/`4318`                | `admin`                                   |

As senhas ficam em `infra/secrets/` (fora do git). As portas podem ser trocadas por variáveis de ambiente (`POSTGRES_PORT`, `VALKEY_PORT`, `HTTP_PORT`...).

## Estrutura

| Caminho                        | Conteúdo                                                              |
| ------------------------------ | --------------------------------------------------------------------- |
| `compose/compose.yml`          | todos os contêineres, perfis, secrets e limites de memória            |
| `postgres/services.txt`        | catálogo de serviços com banco próprio                                |
| `postgres/init/01-services.sh` | cria database, `<svc>_app` (DML) e `<svc>_migrator` (DDL) por serviço |
| `rabbitmq/`                    | plugins (`stream`, `stream_management`, `management`) e configuração  |
| `traefik/`                     | entrypoints, redirecionamento HTTP→HTTPS e certificado                |
| `mkcert/`                      | imagem one-shot que gera a CA e o certificado de `*.broker.localhost` |
| `minio/init.sh`                | buckets e object lock do `audit-anchors`                              |
| `docker/Dockerfile`            | imagem única dos serviços (`--build-arg SERVICE=@broker/<pacote>`)    |
| `scripts/`                     | `env.mjs` (comandos `env:*`) e `secrets.mjs` (gera os segredos)       |
| `tests/`                       | verificação do isolamento do Postgres, da borda TLS e do storage      |

## Adicionar um serviço

1. Acrescente o nome em `postgres/services.txt` e rode `pnpm env:up` (o init é idempotente e cria o database).
2. No compose, declare os secrets `db_<svc>_app` e `db_<svc>_migrator`, o one-shot `<svc>-migrate` e o serviço com `depends_on: <svc>-migrate: service_completed_successfully`, seguindo o `example-service`.
3. Ponha o serviço no perfil `core` ou `full`.
