import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  accountCheckDigit,
  createProtocol,
  createUuidV7Generator,
  formatAccountNumber,
  formatNoteNumber,
  isUuidV7,
  isValidAccountNumber,
  isValidProtocol,
  parseNoteNumber,
  uuidv7,
  uuidV7Timestamp,
} from '../src/index.js';

describe('UUID v7 (RN-PAD-060)', () => {
  it('RN-PAD-060: gera UUID versão 7 com variante RFC 9562 e o timestamp embutido', () => {
    const id = createUuidV7Generator({ now: () => Date.UTC(2026, 9, 16, 20) })();
    expect(isUuidV7(id)).toBe(true);
    expect(uuidV7Timestamp(id)).toBe(Date.UTC(2026, 9, 16, 20));
  });

  it('RN-PAD-060: IDs gerados em sequência são crescentes na ordem lexicográfica', () => {
    const ids = Array.from({ length: 10_000 }, () => uuidv7());
    for (let i = 1; i < ids.length; i++) expect(ids[i]! > ids[i - 1]!).toBe(true);
  });

  it('RN-PAD-060: crescentes mesmo no mesmo milissegundo, com estouro do contador e relógio voltando', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -2, max: 3 }), { minLength: 1, maxLength: 6000 }),
        (steps) => {
          let t = 1_760_000_000_000;
          const gen = createUuidV7Generator({ now: () => t });
          let previous = gen();
          for (const step of steps) {
            t += step; // 0 = mesmo ms; negativo = relógio voltou
            const next = gen();
            expect(isUuidV7(next)).toBe(true);
            expect(next > previous).toBe(true);
            previous = next;
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('é determinístico com relógio e aleatoriedade injetados', () => {
    const make = () =>
      createUuidV7Generator({ now: () => 1_760_000_000_000, randomFill: (b) => b.fill(7) });
    expect(make()()).toBe(make()());
  });
});

describe('número de conta NNNNNNN-D (RN-ACC-001)', () => {
  it('RN-ACC-001: 7 dígitos + DV módulo 11', () => {
    expect(formatAccountNumber(1)).toBe('0000001-9');
    // 7×2 + 6×3 + 5×4 + 4×5 + 3×6 + 2×7 + 1×8 = 112; 112 mod 11 = 2; DV = 11 − 2 = 9.
    expect(formatAccountNumber(1234567)).toBe('1234567-9');
    expect(accountCheckDigit('0000001')).toBe(9);
  });

  it('RN-ACC-001: o DV detecta troca de um dígito, salvo a colisão 10/11 → 0 do módulo 11 (propriedade)', () => {
    const residue = (digits: string) => {
      let sum = 0;
      for (let i = 0; i < 7; i++) sum += Number(digits[6 - i]) * (i + 2);
      return 11 - (sum % 11);
    };
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9_999_999 }),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 1, max: 9 }),
        (seq, pos, delta) => {
          const account = formatAccountNumber(seq);
          expect(isValidAccountNumber(account)).toBe(true);
          const digits = account.slice(0, 7).split('');
          digits[pos] = String((Number(digits[pos]) + delta) % 10);
          const tampered = digits.join('');
          // Os restos 10 e 11 viram o mesmo DV 0: é a única troca de um dígito que passa.
          const collision = residue(tampered) >= 10 && residue(account.slice(0, 7)) >= 10;
          expect(isValidAccountNumber(`${tampered}-${account.slice(8)}`)).toBe(collision);
        },
      ),
    );
  });

  it('recusa sequencial fora da faixa e formatos inválidos', () => {
    expect(() => formatAccountNumber(0)).toThrow();
    expect(() => formatAccountNumber(10_000_000)).toThrow();
    expect(isValidAccountNumber('0000000-0')).toBe(false);
    expect(isValidAccountNumber('1234567')).toBe(false);
  });
});

describe('número de nota e protocolo (RN-PAD-061, RN-NTC-002)', () => {
  it('RN-NTC-002: número da nota sequencial por conta com 9 dígitos', () => {
    expect(formatNoteNumber(42)).toBe('000000042');
    expect(parseNoteNumber('000000042')).toBe(42);
    expect(() => formatNoteNumber(0)).toThrow();
    expect(() => parseNoteNumber('42')).toThrow();
  });

  it('RN-PAD-061/062: protocolo legível e não sequencial', () => {
    const p = createProtocol('SAQ', '2026-10-19', { randomFill: (b) => b.fill(0xff) });
    expect(p).toBe('SAQ-20261019-ZZZZZZZZ');
    expect(isValidProtocol(createProtocol('SAQ', '2026-10-19'))).toBe(true);
    expect(isValidProtocol('SAQ-20261019-ILOU0000')).toBe(false);
    expect(() => createProtocol('saq', '2026-10-19')).toThrow();
  });
});
