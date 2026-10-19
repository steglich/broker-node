// Configuração ESLint compartilhada (flat config).
// - Hexagonal: `domain/` não importa `adapters/`, `config/` nem bibliotecas de infraestrutura (RN-BE-001, D3).
// - Determinismo: `Date.now`, `new Date()` sem argumento e `Math.random` são proibidos em `**/domain/**` (ADR-0009).
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const DOMAIN_FILES = ['**/domain/**/*.{ts,mts,cts,js,mjs}'];

/** Bibliotecas de infraestrutura que o domínio nunca importa. */
export const INFRA_MODULES = [
  'express',
  'pg',
  'kysely',
  'amqplib',
  'rabbitmq-stream-js-client',
  'undici',
  'iovalkey',
  'ioredis',
  'pino',
  'minio',
  '@aws-sdk/*',
  '@opentelemetry/*',
  'node:fs',
  'node:net',
  'node:http',
  'node:https',
  'node:child_process',
];

const nondeterminism = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Date.now() é proibido no domínio: use a porta Clock (ADR-0009).',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'new Date() sem argumento é proibido no domínio: use a porta Clock (ADR-0009).',
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message: 'Math.random é proibido no domínio: use um gerador com semente (ADR-0009).',
  },
];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/.turbo/**'],
  },
  js.configs.recommended,
  {
    // Todo o código roda em Node.js (serviços, scripts e testes).
    languageOptions: { globals: globals.node },
  },
  ...tseslint.configs.recommended,
  {
    plugins: { import: importX },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver({ alwaysTryTypes: true })],
    },
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: '**/domain/**',
              from: ['**/adapters/**', '**/config/**', '**/application/**'],
              message: 'O domínio não importa aplicação, adaptadores nem configuração (RN-BE-001).',
            },
            {
              target: '**/application/**',
              from: ['**/adapters/**'],
              message: 'A aplicação depende de portas, não de adaptadores (RN-BE-001).',
            },
          ],
        },
      ],
    },
  },
  {
    files: DOMAIN_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...nondeterminism],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: INFRA_MODULES,
              message: 'O domínio não importa bibliotecas de infraestrutura (RN-BE-001).',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
