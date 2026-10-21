import { defineProject } from 'vitest/config';

// Verificações contra o ambiente local rodando (`pnpm env:up infra`): fora do `pnpm test`,
// rodam com `pnpm test:infra`.
export default defineProject({
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'example-service-e2e',
    include: ['test/e2e/**/*.e2e.ts'],
    testTimeout: 90_000,
    hookTimeout: 120_000,
  },
});
