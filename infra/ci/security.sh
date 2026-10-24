#!/usr/bin/env bash
# Segurança do pipeline (RN-CICD §2): SAST (Semgrep), SCA (osv-scanner) e segredos (gitleaks).
# Roda igual no CI e na máquina: as ferramentas vêm das imagens Docker de infra/ci/tools.env.
#
#   infra/ci/security.sh [sast|sca|secrets|all]
#   SECRETS_BASE=<sha>  limita o gitleaks aos commits SECRETS_BASE..HEAD (o PR); sem ela, todo o histórico.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# shellcheck source=infra/ci/tools.env
source infra/ci/tools.env
run() { docker run --rm -v "$PWD:/src" -w /src "$@"; }

sast() {
  echo "::group::Semgrep (SAST)"
  run "$SEMGREP_IMAGE" semgrep --test --metrics=off --config .semgrep/broker.yml .semgrep/broker.ts
  # --error: código 1 se houver achado de severidade ERROR (as regras de alto impacto).
  run "$SEMGREP_IMAGE" semgrep scan --metrics=off --error --severity ERROR \
    --config p/typescript --config p/nodejs --config p/expressjs --config p/secrets --config .semgrep/broker.yml
  echo "::endgroup::"
}

sca() {
  echo "::group::osv-scanner (SCA)"
  local report
  report="$(mktemp)"
  # O osv-scanner sai com 1 quando acha qualquer vulnerabilidade; quem decide o bloqueio é o osv-gate.
  run "$OSV_SCANNER_IMAGE" scan source --lockfile pnpm-lock.yaml --format json > "$report" || true
  node infra/ci/osv-gate.mjs "$report"
  echo "::endgroup::"
}

secrets() {
  echo "::group::gitleaks (segredos)"
  local opts=()
  if [[ -n "${SECRETS_BASE:-}" ]]; then opts=(--log-opts="${SECRETS_BASE}..HEAD"); fi
  run -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$GITLEAKS_IMAGE" git --no-banner --redact --verbose "${opts[@]}" .
  echo "::endgroup::"
}

case "${1:-all}" in
  sast) sast ;;
  sca) sca ;;
  secrets) secrets ;;
  all) sast; sca; secrets ;;
  *) echo "uso: $0 [sast|sca|secrets|all]" >&2; exit 2 ;;
esac
