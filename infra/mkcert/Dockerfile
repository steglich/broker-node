# Gera a CA local e o certificado de *.broker.localhost sem instalar o mkcert na máquina (RN-ENV-030).
FROM alpine:3.22
ARG MKCERT_VERSION=v1.4.4
ARG MKCERT_SHA256=6d31c65b03972c6dc4a14ab429f2928300518b26503f58723e532d1b0a3bbb52
RUN apk add --no-cache ca-certificates wget \
 && wget -qO /usr/local/bin/mkcert "https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/mkcert-${MKCERT_VERSION}-linux-amd64" \
 && echo "${MKCERT_SHA256}  /usr/local/bin/mkcert" | sha256sum -c - \
 && chmod +x /usr/local/bin/mkcert
COPY generate.sh /usr/local/bin/generate-certs
ENTRYPOINT ["/bin/sh", "/usr/local/bin/generate-certs"]
