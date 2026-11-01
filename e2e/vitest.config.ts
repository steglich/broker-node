import { defineProject } from 'vitest/config';

// Jornadas contra o ambiente rodando (`CLOCK_MODE=VIRTUAL pnpm env:up core`): fora do `pnpm test`,
// rodam com `pnpm test:e2e`.
export default defineProject({
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'e2e',
    include: ['test/**/*.e2e.ts'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
