import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { murmur32, partitionIndex } from '../src/index.js';

// Implementação interna da biblioteca (não exportada): é a referência do roteamento `hash`.
const require = createRequire(import.meta.url);
const libraryDir = require.resolve('rabbitmq-stream-js-client').replace(/index\.js$/, '');
const { murmur32: libraryMurmur } = require(`${libraryDir}hash/murmur32.js`) as {
  murmur32: (k: string) => number;
};

describe('roteamento por chave (ADR-0001, achado 1)', () => {
  it('murmur3 igual ao do cliente oficial para chaves de vários tamanhos e acentos', () => {
    const keys = [
      '',
      'a',
      'ab',
      'abc',
      'abcd',
      'account-1',
      '0192a3c0-0000-7000-8000-000000000001',
      'ação',
      'PETR4',
    ];
    for (let i = 0; i < 500; i++) keys.push(`key-${i}-${'x'.repeat(i % 7)}`);
    for (const key of keys) expect(murmur32(key)).toBe(libraryMurmur(key) >>> 0);
  });

  it('a mesma chave sempre na mesma partição', () => {
    expect(partitionIndex('account-1', 3)).toBe(partitionIndex('account-1', 3));
    expect(new Set(Array.from({ length: 100 }, (_, i) => partitionIndex(`k${i}`, 3))).size).toBe(3);
  });
});
