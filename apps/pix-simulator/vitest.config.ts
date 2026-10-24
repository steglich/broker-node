import { defineProject } from 'vitest/config';

export default defineProject({
  // Usa o código-fonte dos pacotes @broker/* (condição `source` do exports), sem build prévio.
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    name: 'pix-simulator',
    include: ['test/**/*.test.ts'],
    // Os testes de componente sobem um PostgreSQL real com Testcontainers.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
