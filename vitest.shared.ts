import type { ViteUserConfig } from 'vitest/config';

type Coverage = NonNullable<NonNullable<ViteUserConfig['test']>['coverage']>;

/** Mínimo de cobertura do domínio (D20, RN-CICD §2): 80% de linhas, funções, ramos e instruções. */
export const DOMAIN_THRESHOLD = { lines: 80, functions: 80, branches: 80, statements: 80 };

/**
 * Cobertura de um pacote quando ele roda sozinho (`pnpm --filter <pkg> test -- --coverage`, que é
 * como o CI roda via Turborepo). `domain: true` aplica o limite ao pacote inteiro (pacotes que
 * são só domínio); nos demais, o limite vale para as pastas `domain/`.
 */
export function packageCoverage(options: { domain?: boolean } = {}): Coverage {
  return {
    provider: 'v8',
    reporter: ['text-summary', 'json-summary'],
    include: ['src/**'],
    exclude: ['**/*.test.ts', '**/dist/**'],
    thresholds: options.domain ? DOMAIN_THRESHOLD : { '**/domain/**': DOMAIN_THRESHOLD },
  };
}
