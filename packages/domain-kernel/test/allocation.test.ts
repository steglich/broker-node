import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocate, DomainError, Money } from '../src/index.js';

const brl = (v: string) => Money.of(v, 'BRL');
const amounts = (m: Map<string, Money>) =>
  Object.fromEntries([...m].map(([k, v]) => [k, v.toString()]));

describe('rateio pelo maior resto (RN-FEE-031)', () => {
  it('FEE-010: R$ 0,10 entre três negócios de notional igual; o centavo vai para o menor trade_id', () => {
    const result = allocate(brl('0.10'), [
      { id: '0192a3c0-0000-7000-8000-000000000003', weight: '1000.00' },
      { id: '0192a3c0-0000-7000-8000-000000000001', weight: '1000.00' },
      { id: '0192a3c0-0000-7000-8000-000000000002', weight: '1000.00' },
    ]);
    expect(amounts(result)).toEqual({
      '0192a3c0-0000-7000-8000-000000000001': '0.04',
      '0192a3c0-0000-7000-8000-000000000002': '0.03',
      '0192a3c0-0000-7000-8000-000000000003': '0.03',
    });
  });

  it('RN-FEE-031: os centavos que sobram vão primeiro para os maiores restos', () => {
    // exatos: 1,4 / 1,4 / 4,2 centavos → pisos 1/1/4, sobra 1 centavo; restos 0,4 / 0,4 / 0,2.
    // a e b empatam no resto e no peso, e o menor id (a) recebe.
    const result = allocate(brl('0.07'), [
      { id: 'a', weight: '1' },
      { id: 'b', weight: '1' },
      { id: 'c', weight: '3' },
    ]);
    expect(amounts(result)).toEqual({ a: '0.02', b: '0.01', c: '0.04' });
  });

  it('RN-FEE-031: com restos iguais, o resíduo vai para o item de maior valor', () => {
    // exatos: 0,5 / 1,5 centavo → pisos 0/1, sobra 1; restos empatados (0,5) → maior peso (b) recebe.
    const result = allocate(brl('0.02'), [
      { id: 'a', weight: '1' },
      { id: 'b', weight: '3' },
    ]);
    expect(amounts(result)).toEqual({ a: '0.00', b: '0.02' });
  });

  it('RN-FEE-031: com resto e valor iguais, desempata pelo menor id', () => {
    // exatos: 0,5 / 1 / 0,5 → pisos 0/1/0, sobra 1; a e c empatam em resto e peso → a (menor id).
    const result = allocate(brl('0.02'), [
      { id: 'c', weight: '1' },
      { id: 'b', weight: '2' },
      { id: 'a', weight: '1' },
    ]);
    expect(amounts(result)).toEqual({ a: '0.01', b: '0.01', c: '0.00' });
  });

  it('ADR-0004: Σ partes = total, cada parte em centavos e diferença < 1 centavo da proporção (propriedade)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 9n), max: 10n ** 9n }),
        fc.uniqueArray(
          fc.record({
            id: fc.uuid({ version: 7 }),
            weight: fc.bigInt({ min: 0n, max: 10n ** 10n }),
          }),
          { minLength: 1, maxLength: 20, selector: (i) => i.id },
        ),
        (totalMinor, rawItems) => {
          fc.pre(rawItems.some((i) => i.weight > 0n));
          const items = rawItems.map((i) => ({ id: i.id, weight: `${i.weight}.00` }));
          const total = Money.fromMinor(totalMinor, 'BRL');
          const result = allocate(total, items);

          const sum = [...result.values()].reduce((a, b) => a.plus(b), Money.zero('BRL'));
          expect(sum.equals(total)).toBe(true);
          for (const part of result.values())
            expect(part.amount.decimalPlaces()).toBeLessThanOrEqual(2);

          // Determinismo: a ordem de entrada não muda o resultado.
          const reversed = allocate(total, [...items].reverse());
          for (const [id, part] of result) expect(reversed.get(id)!.equals(part)).toBe(true);
        },
      ),
    );
  });

  it('recusa rateio sem itens, com pesos zerados, negativos ou IDs repetidos', () => {
    expect(() => allocate(brl('1.00'), [])).toThrow(DomainError);
    expect(() => allocate(brl('1.00'), [{ id: 'a', weight: '0' }])).toThrow(/soma dos pesos/);
    expect(() => allocate(brl('1.00'), [{ id: 'a', weight: '-1' }])).toThrow(/negativo/);
    expect(() =>
      allocate(brl('1.00'), [
        { id: 'a', weight: '1' },
        { id: 'a', weight: '1' },
      ]),
    ).toThrow(/repetidos/);
    expect(() => allocate(brl('0.105'), [{ id: 'a', weight: '1' }])).toThrow(/arredonde antes/);
  });
});
