import { defineProject } from 'vitest/config';

export default defineProject({
  // Usa o código-fonte dos pacotes @broker/* (condição `source` do exports), sem build prévio.
  ssr: { resolve: { conditions: ['source'] } },
  test: { name: 'domain-kernel', include: ['test/**/*.test.ts'] },
});
