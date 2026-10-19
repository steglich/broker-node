import { defineProject } from 'vitest/config';

// Testes contra o ambiente rodando (`pnpm env:up`). Ficam fora do `pnpm test` e rodam com `pnpm test:infra`.
export default defineProject({
  test: {
    name: 'infra',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
