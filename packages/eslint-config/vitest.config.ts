import { defineConfig } from 'vitest/config';
import { packageCoverage } from '../../vitest.shared.js';

export default defineConfig({
  test: {
    // Cobertura quando o pacote roda sozinho (CI via Turborepo: `turbo run test -- --coverage`).
    coverage: packageCoverage(),
    name: 'eslint-config',
    include: ['test/**/*.test.ts'],
  },
});
