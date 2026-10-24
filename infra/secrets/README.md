# Segredos locais

Esta pasta simula o cofre de segredos (D18). Tudo aqui, menos este README, fica **fora do git**.

Os arquivos são gerados por `node infra/scripts/secrets.mjs`, que o `pnpm env:up` chama sozinho. Cada arquivo tem um segredo, e os contêineres o leem como Docker secret em `/run/secrets/<nome>`.

| Arquivo                  | Uso                                                                             |
| ------------------------ | ------------------------------------------------------------------------------- |
| `postgres_password`      | superusuário `postgres`                                                         |
| `rabbitmq_password`      | usuário `broker` do RabbitMQ                                                    |
| `valkey_password`        | `requirepass` do Valkey                                                         |
| `minio_root_password`    | usuário raiz `broker` do MinIO                                                  |
| `grafana_admin_password` | usuário `admin` do Grafana                                                      |
| `db/<svc>_app`           | usuário de aplicação (DML) do serviço `<svc>`                                   |
| `db/<svc>_migrator`      | usuário de migração (DDL) do serviço `<svc>`                                    |
| `webhook/<simulador>`    | HMAC dos webhooks do simulador (RN-SIM-003)                                     |
| `crypto/identity_*`      | chave-mestra da cifra de campo e chave do HMAC de busca do identity (RN-DB-031) |

Para trocar todas as senhas, apague a pasta (menos este README) e destrua os volumes com `pnpm env:down --volumes`.
