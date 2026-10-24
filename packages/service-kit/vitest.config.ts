import { defineConfig } from 'vitest/config';
import { packageCoverage } from '../../vitest.shared.js';

export default defineConfig({
  // Usa o código-fonte dos pacotes @broker/* (condição `source` do exports), sem build prévio.
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    // Cobertura quando o pacote roda sozinho (CI via Turborepo: `turbo run test -- --coverage`).
    coverage: packageCoverage(),
    name: 'service-kit',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Os testes de integração sobem PostgreSQL e Valkey reais com Testcontainers.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
