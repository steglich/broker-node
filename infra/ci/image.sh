#!/usr/bin/env bash
# Artefato de um serviço (RN-CICD §2): imagem do Dockerfile único, SBOM (syft, SPDX) e assinatura
# (cosign) da imagem e do SBOM como atestado. Igual no CI e na máquina; ferramentas via Docker.
#
#   infra/ci/image.sh <app>        ex.: infra/ci/image.sh pix-simulator
#
#   REGISTRY   prefixo da imagem (padrão: broker). Para assinar, precisa ser um registry (push).
#   PUSH=1     envia a imagem ao registry (exigido pela assinatura, que é sobre o digest).
#   SIGN       none (padrão) | key (COSIGN_KEY/COSIGN_PUB + COSIGN_PASSWORD, sem log público, para teste
#              local) | keyless (OIDC do CI; a assinatura fica no log público Rekor, como no Sigstore)
#   OUT        pasta do SBOM (padrão: out/sbom)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# shellcheck source=infra/ci/tools.env
source infra/ci/tools.env

app="${1:?uso: $0 <app>}"
test -f "apps/$app/package.json" || { echo "apps/$app não existe" >&2; exit 2; }
registry="${REGISTRY:-broker}"
commit="$(git rev-parse HEAD)"
version="$(node -p "require('./apps/$app/package.json').version")"
image="$registry/$app:$commit"
out="${OUT:-out/sbom}"
mkdir -p "$out"

echo "::group::build $image (versão $version)"
docker build -f infra/docker/Dockerfile \
  --build-arg SERVICE="@broker/$app" --build-arg GIT_COMMIT="$commit" --build-arg SERVICE_VERSION="$version" \
  --label org.opencontainers.image.created="$(git log -1 --format=%cI)" \
  -t "$image" -t "$registry/$app:$version" .
echo "::endgroup::"

echo "::group::SBOM (syft)"
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/$out:/out" "$SYFT_IMAGE" \
  "docker:$image" -o "spdx-json=/out/$app.spdx.json" -q
node -e "const s=require('./$out/$app.spdx.json');console.log(\`\${s.packages.length} pacotes no SBOM de $app\`)"
echo "::endgroup::"

ref="$image"
if [[ "${PUSH:-0}" == 1 ]]; then
  docker push -q "$image" >/dev/null
  docker push -q "$registry/$app:$version" >/dev/null
  ref="$(docker inspect --format '{{index .RepoDigests 0}}' "$image")"
  echo "enviada: $ref"
fi

sign_mode="${SIGN:-none}"
if [[ "$sign_mode" != none ]]; then
  [[ "${PUSH:-0}" == 1 ]] || { echo "SIGN exige PUSH=1 (a assinatura é sobre o digest no registry)" >&2; exit 2; }
  echo "::group::assinatura (cosign, $sign_mode)"
  cosign() {
    # DOCKER_CONFIG: credenciais do registry do `docker login` do host (a imagem roda sem root).
    docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \
      -v "$PWD:/w" -w /w -v "$HOME/.docker:/docker:ro" -e DOCKER_CONFIG=/docker \
      -e COSIGN_PASSWORD -e COSIGN_YES=true \
      -e ACTIONS_ID_TOKEN_REQUEST_URL -e ACTIONS_ID_TOKEN_REQUEST_TOKEN \
      "$COSIGN_IMAGE" "$@"
  }
  if [[ "$sign_mode" == key ]]; then
    # Chave local: nada vai para o log público de transparência (Rekor); isso é do modo keyless.
    keyargs=(--key "${COSIGN_KEY:?}" --use-signing-config=false --tlog-upload=false)
    verifyargs=(--key "${COSIGN_PUB:?}" --insecure-ignore-tlog=true)
    # Registry local de teste em HTTP.
    [[ "$registry" == localhost:* ]] && keyargs+=(--allow-insecure-registry) && verifyargs+=(--allow-insecure-registry)
  else
    # Keyless (Sigstore): identidade = o workflow deste repositório, via token OIDC do GitHub Actions.
    keyargs=(); verifyargs=(
      --certificate-identity-regexp "^https://github.com/steglich/broker-node/"
      --certificate-oidc-issuer https://token.actions.githubusercontent.com)
  fi
  cosign sign "${keyargs[@]}" "$ref"
  cosign attest "${keyargs[@]}" --type spdxjson --predicate "$out/$app.spdx.json" "$ref"
  cosign verify "${verifyargs[@]}" "$ref" >/dev/null
  cosign verify-attestation "${verifyargs[@]}" --type spdxjson "$ref" >/dev/null
  echo "assinatura e atestado do SBOM verificados: $ref"
  echo "::endgroup::"
fi
