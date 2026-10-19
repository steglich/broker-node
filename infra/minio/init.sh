#!/bin/sh
# Cria os buckets do MinIO (D16). Idempotente.
#   documents, reports  documentos de onboarding e relatórios
#   brapi-raw           respostas brutas da brapi, expiram em 30 dias
#   audit-anchors       âncoras diárias da trilha de auditoria: object lock (WORM) em modo
#                       COMPLIANCE, nem o usuário raiz apaga ou altera uma versão gravada (RN-AUD-002)
set -eu
mc alias set local http://minio:9000 broker "$(cat /run/secrets/minio_root_password)" >/dev/null

for b in documents reports brapi-raw; do
  mc mb --ignore-existing "local/$b"
done
# A imagem não tem grep: o teste de "regra já existe" é feito com case.
rules=$(mc ilm rule ls --json local/brapi-raw 2>/dev/null || true)
case "$rules" in
  *Expiration*) ;;
  *) mc ilm rule add --expire-days 30 local/brapi-raw ;;
esac

mc mb --ignore-existing --with-lock local/audit-anchors
mc retention set --default COMPLIANCE "${AUDIT_ANCHOR_RETENTION:-3650d}" local/audit-anchors
echo "buckets prontos"
