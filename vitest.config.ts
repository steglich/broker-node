import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Cada pacote/serviço com vitest.config.ts vira um projeto; a cobertura sai por projeto.
    projects: [
      'packages/*/vitest.config.ts',
      'apps/*/vitest.config.ts',
      'contracts/vitest.config.ts',
      'scenarios/vitest.config.ts',
      'infra/vitest.ci.config.ts',
      // Testes contra o ambiente Docker rodando: fora do `pnpm test`, rodam com `pnpm test:infra`.
      'infra/vitest.config.ts',
      'apps/example-service/vitest.e2e.config.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/*.test.ts', '**/dist/**', 'apps/example-service/**'],
      // Limite mínimo de 80% no domínio (D20, D21).
      thresholds: {
        '**/domain/**': { lines: 80, functions: 80, branches: 80, statements: 80 },
        'packages/domain-kernel/src/**': { lines: 80, functions: 80, branches: 80, statements: 80 },
        'packages/calendar/src/**': { lines: 80, functions: 80, branches: 80, statements: 80 },
      },
    },
  },
});
