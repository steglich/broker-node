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

Perfis: `infra` sobe a infraestrutura e os simuladores externos (para rodar serviços fora do contêiner), `core` acrescenta os serviços do núcleo e `full` todos os serviços.

## Endereços

| Serviço                   | Endereço                                                    | Usuário                                   |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| PostgreSQL                | `localhost:5432`                                            | `postgres`, `<svc>_app`, `<svc>_migrator` |
| RabbitMQ (AMQP/stream/UI) | `localhost:5672` / `5552` / http://localhost:15672          | `broker`                                  |
| Valkey                    | `localhost:6380` (6380 para não colidir com um Redis local) | senha em `secrets/valkey_password`        |
| MinIO (S3/console)        | `localhost:9000` / http://localhost:9001                    | `broker`                                  |
| Mailpit                   | https://mail.broker.localhost ou http://localhost:8025      | —                                         |
| Banco Simulado (PIX)      | https://bank.broker.localhost/ui                            | —                                         |
| KYC simulado              | https://kyc.broker.localhost/ui                             | —                                         |
| SMS e push (message-sink) | https://sms.broker.localhost/ui                             | —                                         |
| Grafana (LGTM)            | http://localhost:3000; OTLP em `4317`/`4318`                | `admin`                                   |

### Falhas simuladas e e-mail real

- Latência e falhas dos simuladores (RN-SIM-002): `SIM_LATENCY_MS` (`200` ou `100-500`), `SIM_TRANSIENT_ERROR_RATE`, `SIM_DEFINITIVE_ERROR_RATE` e `SIM_UNAVAILABLE` (`<início>/<fim>` ISO). Também mudam em tempo de execução pela UI de cada simulador ou por `PUT /admin/behavior`.
- E-mail (RN-MSG-001): tudo fica no Mailpit. Para receber de verdade no seu e-mail, defina `MAIL_RELAY_HOST` (e `MAIL_RELAY_PORT`, `MAIL_RELAY_AUTH`, `MAIL_RELAY_USERNAME`, `MAIL_RELAY_PASSWORD`) e `MAIL_RELAY_ALLOWLIST` com uma regex, ex.: `^seu\.email@exemplo\.com$`. Só esses destinatários saem; os demais ficam só na caixa.

As senhas ficam em `infra/secrets/` (fora do git), inclusive os segredos HMAC dos webhooks (`secrets/webhook/`). As portas podem ser trocadas por variáveis de ambiente (`POSTGRES_PORT`, `VALKEY_PORT`, `HTTP_PORT`...).

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
