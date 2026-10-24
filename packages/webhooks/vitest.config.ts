import { defineProject } from 'vitest/config';

export default defineProject({
  // Usa o código-fonte dos pacotes @broker/* (condição `source` do exports), sem build prévio.
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'webhooks',
    include: ['test/**/*.test.ts'],
    // O teste do despachante sobe um PostgreSQL real com Testcontainers.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
