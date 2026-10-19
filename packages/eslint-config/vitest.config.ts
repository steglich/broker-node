import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'eslint-config',
    include: ['test/**/*.test.ts'],
  },
});
