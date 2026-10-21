import { defineProject } from 'vitest/config';

export default defineProject({
  // Usa o código-fonte dos pacotes @broker/* (condição `source` do exports), sem build prévio.
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'service-kit',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Os testes de integração sobem PostgreSQL e Valkey reais com Testcontainers.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
