import { defineConfig } from 'vitest/config';

// Testes das ferramentas do pipeline (infra/ci): não precisam do ambiente rodando e entram no `pnpm test`.
export default defineConfig({
  test: { name: 'ci-tools', include: ['ci/test/**/*.test.ts'], testTimeout: 30_000 },
});
