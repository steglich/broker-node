#!/usr/bin/env bash
# Roda localmente os mesmos jobs do .github/workflows/ci.yml, na mesma ordem, como num PR contra
# BASE (padrão: main). Para no primeiro job que falhar, como o merge bloqueado (RN-CICD §2).
#
#   infra/ci/local.sh [base]       ex.: infra/ci/local.sh origin/main
#   SKIP_IMAGES=1                  pula o build das imagens (o job mais lento)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
base="$(git rev-parse "${1:-main}")"
head="$(git rev-parse HEAD)"
export TURBO_SCM_BASE="$base" TURBO_SCM_HEAD="$head" TURBO_TELEMETRY_DISABLED=1
job() { echo; echo "━━━ $1"; }

job "quality: formatação, lint, typecheck e commits"
pnpm format:check
pnpm lint
pnpm turbo run typecheck --affected
pnpm commitlint --from "$TURBO_SCM_BASE" --to "$TURBO_SCM_HEAD"

job "test: unitários (cobertura), integração e componente"
pnpm turbo run test --affected -- --coverage

job "contracts: contratos e compatibilidade de esquemas"
pnpm contracts:check --base "$TURBO_SCM_BASE"
pnpm scenarios

job "security: SAST, SCA e segredos"
infra/ci/security.sh sast
infra/ci/security.sh sca
SECRETS_BASE="$TURBO_SCM_BASE" infra/ci/security.sh secrets

if [[ "${SKIP_IMAGES:-0}" != 1 ]]; then
  for app in $(node infra/ci/affected-apps.mjs | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).join(' ')))"); do
    job "image: $app (build e SBOM; push e assinatura só no CI)"
    infra/ci/image.sh "$app"
  done
fi
echo; echo "✓ pipeline local OK (base ${base:0:7})"
