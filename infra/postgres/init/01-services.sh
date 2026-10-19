#!/usr/bin/env bash
# Cria, para cada serviço do catálogo, o database e duas credenciais (RN-DB-001, RN-DB-032):
#   <svc>_migrator  dono do database e do schema public: DDL (migrações)
#   <svc>_app       só DML (SELECT/INSERT/UPDATE/DELETE) nas tabelas criadas pelo migrador
# Ninguém além deles conecta no database (REVOKE CONNECT ... FROM PUBLIC).
#
# Roda no primeiro start do contêiner (docker-entrypoint-initdb.d) e de novo a cada
# `pnpm env:up`, por isso é idempotente: cria o que falta e sincroniza as senhas.
set -euo pipefail

CATALOG=${CATALOG:-/etc/broker/services.txt}
SECRETS=${SECRETS:-/run/secrets/db}
export PGUSER=${POSTGRES_USER:-postgres}

psql_admin() { psql -v ON_ERROR_STOP=1 --no-psqlrc -q "$@"; }

grep -Ev '^\s*(#|$)' "$CATALOG" | while read -r svc; do
  if [[ ! "$svc" =~ ^[a-z][a-z0-9_]*$ ]]; then
    echo "nome de serviço inválido no catálogo: '$svc'" >&2
    exit 1
  fi
  app="${svc}_app"
  migrator="${svc}_migrator"
  app_pw=$(cat "$SECRETS/$app")
  migrator_pw=$(cat "$SECRETS/$migrator")

  # 1) Papéis e database (no database postgres).
  psql_admin -d postgres -v svc="$svc" -v app="$app" -v migrator="$migrator" \
    -v app_pw="$app_pw" -v migrator_pw="$migrator_pw" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'migrator')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'migrator') \gexec
SELECT format('CREATE ROLE %I LOGIN', :'app')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'migrator', :'migrator_pw') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'app', :'app_pw') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'svc', :'migrator')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'svc') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'svc') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'svc', :'app') \gexec
SQL

  # 2) Permissões dentro do database do serviço.
  psql_admin -d "$svc" -v app="$app" -v migrator="$migrator" <<'SQL'
SELECT format('ALTER SCHEMA public OWNER TO %I', :'migrator') \gexec
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'migrator', :'app') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', :'migrator', :'app') \gexec
SQL
  echo "database '$svc' pronto ($app, $migrator)"
done
