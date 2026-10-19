import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../index.js';

const fixture = fileURLToPath(new URL('./fixtures/domain/violations.ts', import.meta.url));

describe('@broker/eslint-config', () => {
  it('RN-BE-001/ADR-0009: rejeita adaptador, infraestrutura e não determinismo no domínio', async () => {
    const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config });
    const [result] = await eslint.lintFiles([fixture]);
    const hits = result!.messages.map((m) => `${m.line}:${m.ruleId}`);

    expect(hits).toEqual([
      '2:import/no-restricted-paths',
      '4:no-restricted-syntax',
      '5:no-restricted-syntax',
      '6:no-restricted-syntax',
      '8:no-restricted-imports',
    ]);
  });
});
