import { Instant } from '@broker/domain-kernel';
import { describe, expect, it } from 'vitest';
import {
  AcceleratedClock,
  createClock,
  RealClock,
  timestamps,
  VirtualClock,
} from '../src/index.js';

const at = (iso: string) => Instant.parse(iso);

describe('relógio do sistema (RN-CLK-001..004)', () => {
  it('RN-CLK-002: REAL segue o relógio da máquina', () => {
    let wall = Date.UTC(2026, 9, 16, 13, 0);
    const clock = new RealClock(() => wall);
    expect(clock.mode).toBe('REAL');
    expect(clock.now().toString()).toBe('2026-10-16T13:00:00.000Z');
    wall += 60_000;
    expect(clock.now().toString()).toBe('2026-10-16T13:01:00.000Z');
  });

  it('RN-CLK-002: ACCELERATED avança speed_factor vezes mais rápido', () => {
    let wall = 1_000_000;
    const clock = new AcceleratedClock({
      start: at('2026-10-16T12:00:00Z'),
      speedFactor: 24,
      wall: () => wall,
    });
    expect(clock.now().toString()).toBe('2026-10-16T12:00:00.000Z');
    wall += 60 * 60_000; // 1 hora real
    expect(clock.now().toString()).toBe('2026-10-17T12:00:00.000Z'); // 1 dia virtual
    expect(
      () => new AcceleratedClock({ start: at('2026-10-16T12:00:00Z'), speedFactor: 0 }),
    ).toThrow();
  });

  it('RN-CLK-002: VIRTUAL só avança por advance_to e toda regra recebe esse instante', () => {
    const clock = new VirtualClock(at('2026-10-16T12:00:00Z'));
    expect(clock.now().toString()).toBe('2026-10-16T12:00:00.000Z');
    clock.advanceTo(at('2026-10-16T20:00:00Z'));
    expect(clock.now().toString()).toBe('2026-10-16T20:00:00.000Z');
    expect(clock.now().toString()).toBe('2026-10-16T20:00:00.000Z'); // parado até o próximo comando
    clock.advanceBy(30 * 60_000);
    expect(clock.now().toString()).toBe('2026-10-16T20:30:00.000Z');
  });

  it('RN-CLK-002: o relógio virtual não volta no tempo', () => {
    const clock = new VirtualClock(at('2026-10-16T20:00:00Z'));
    expect(() => clock.advanceTo(at('2026-10-16T19:59:59Z'))).toThrow(/não volta/);
    expect(() => clock.advanceBy(-1)).toThrow(/não volta/);
    clock.advanceTo(at('2026-10-16T20:00:00Z')); // mesmo instante é aceito
  });

  it('P-02: virada de dia UTC→BRT na data de negócio', () => {
    const clock = new VirtualClock(at('2026-10-16T23:59:00Z'));
    expect(clock.businessDate().toString()).toBe('2026-10-16');
    clock.advanceTo(at('2026-10-17T01:30:00Z')); // já é dia 17 em UTC
    expect(clock.businessDate().toString()).toBe('2026-10-16'); // ainda 22:30 do dia 16 em São Paulo
    clock.advanceTo(at('2026-10-17T03:00:00Z')); // meia-noite em São Paulo
    expect(clock.businessDate().toString()).toBe('2026-10-17');
  });

  it('RN-CLK-004: occurred_at no tempo do ambiente e wall_clock_at no tempo da máquina', () => {
    const clock = new VirtualClock(at('2027-01-04T13:00:00Z'));
    const t = timestamps(clock, () => Date.UTC(2026, 9, 19, 14, 0));
    expect(t.occurredAt.toString()).toBe('2027-01-04T13:00:00.000Z');
    expect(t.wallClockAt.toString()).toBe('2026-10-19T14:00:00.000Z');
  });

  it('cria o relógio a partir da configuração do ambiente', () => {
    expect(createClock({ mode: 'REAL' }).mode).toBe('REAL');
    expect(createClock({ mode: 'VIRTUAL', start: '2026-10-16T20:00:00Z' }).now().toString()).toBe(
      '2026-10-16T20:00:00.000Z',
    );
    const acc = createClock(
      { mode: 'ACCELERATED', start: '2026-10-16T20:00:00Z', speedFactor: 6.5 },
      () => 0,
    );
    expect(acc.mode).toBe('ACCELERATED');
  });
});
