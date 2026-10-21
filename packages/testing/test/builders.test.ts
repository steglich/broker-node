import { TaxId } from '@broker/domain-kernel';
import { describe, expect, it } from 'vitest';
import { aTaxId, anEnvelope, defineBuilder, testClock } from '../src/index.js';

interface Order {
  id: string;
  side: 'BUY' | 'SELL';
  quantity: number;
}

describe('builders (RN-QA-020)', () => {
  const anOrder = defineBuilder<Order>(({ seq, random }) => ({
    id: `order-${seq}`,
    side: 'BUY',
    quantity: random.int(1, 10) * 100,
  }));

  it('RN-QA-020: padrões válidos, sobrescritos só no que o teste pede', () => {
    anOrder.reset();
    expect(anOrder({ side: 'SELL' })).toMatchObject({ id: 'order-1', side: 'SELL' });
    expect(anOrder().id).toBe('order-2');
    expect(anOrder.many(3).map((o) => o.id)).toEqual(['order-3', 'order-4', 'order-5']);
  });

  it('RN-QA-002: mesma semente, mesmos objetos (independe da ordem dos testes)', () => {
    anOrder.reset();
    const first = anOrder.many(5);
    anOrder.reset();
    expect(anOrder.many(5)).toEqual(first);
  });

  it('RN-QA-021: aTaxId gera CPF válido no cenário de KYC pedido', () => {
    for (const digit of [0, 7, 8, 9] as const) {
      const taxId = aTaxId(digit);
      expect(taxId).toBeInstanceOf(TaxId);
      expect(taxId.digits[9]).toBe(String(digit));
    }
  });

  it('anEnvelope tem um eventId UUID v7 novo a cada chamada', () => {
    const [a, b] = anEnvelope.many(2);
    expect(a!.eventId).not.toBe(b!.eventId);
    expect(a!.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });
});

describe('relógio virtual de teste (RN-QA-002)', () => {
  it('parte de um dia útil e só anda quando o teste manda', () => {
    const clock = testClock();
    expect(clock.mode).toBe('VIRTUAL');
    expect(clock.businessDate().toString()).toBe('2026-01-05');
    clock.advanceBy(60_000);
    expect(clock.now().toString()).toBe('2026-01-05T13:01:00.000Z');
  });

  it('aceita data de negócio com hora local de São Paulo', () => {
    expect(testClock({ date: '2026-02-18', time: '13:00' }).now().toString()).toBe(
      '2026-02-18T16:00:00.000Z',
    );
  });
});
