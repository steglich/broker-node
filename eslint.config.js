import broker from '@broker/eslint-config';

export default [
  ...broker,
  // Fixtures que violam as regras de propósito; verificadas por packages/eslint-config/test/rules.test.ts.
  { ignores: ['packages/eslint-config/test/fixtures/**'] },
];
