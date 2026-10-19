#!/bin/sh
# Cria a CA (uma vez) e o certificado da borda em /certs. Não regera se já existir.
set -eu
export CAROOT=/certs/ca
mkdir -p "$CAROOT"
if [ -s /certs/broker.localhost.pem ]; then
  echo "certificado já existe em /certs"
  exit 0
fi
mkcert -cert-file /certs/broker.localhost.pem -key-file /certs/broker.localhost-key.pem \
  broker.localhost '*.broker.localhost' \
  api.broker.localhost ws.broker.localhost bank.broker.localhost kyc.broker.localhost mail.broker.localhost
chmod 644 /certs/*.pem
echo "CA em infra/certs/ca/rootCA.pem (importe no navegador para confiar)"
