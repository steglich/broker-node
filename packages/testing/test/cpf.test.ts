import { TaxId } from '@broker/domain-kernel';
import { describe, expect, it } from 'vitest';
import { generateCpf, seededRandom, type KycScenarioDigit } from '../src/index.js';

describe('gerador de CPF (RN-ONB §5.2)', () => {
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as KycScenarioDigit[])(
    'gera CPFs válidos com penúltimo dígito %i',
    (digit) => {
      const random = seededRandom(digit + 1);
      for (let i = 0; i < 50; i++) {
        const cpf = generateCpf({ penultimateDigit: digit, random });
        expect(TaxId.parse(cpf).digits).toBe(cpf);
        expect(cpf[9]).toBe(String(digit));
      }
    },
  );

  it('é reprodutível com a mesma semente', () => {
    const a = Array.from(
      { length: 5 },
      (
        (r) => () =>
          generateCpf({ random: r })
      )(seededRandom(42)),
    );
    const b = Array.from(
      { length: 5 },
      (
        (r) => () =>
          generateCpf({ random: r })
      )(seededRandom(42)),
    );
    expect(a).toEqual(b);
  });
});
