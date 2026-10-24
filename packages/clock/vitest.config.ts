import { defineConfig } from 'vitest/config';
import { packageCoverage } from '../../vitest.shared.js';

export default defineConfig({
  // Usa o código-fonte dos pacotes @broker/* (condição `source` do exports), sem build prévio.
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    // Cobertura quando o pacote roda sozinho (CI via Turborepo: `turbo run test -- --coverage`).
    coverage: packageCoverage(),
    name: 'clock',
    include: ['test/**/*.test.ts'],
  },
});
