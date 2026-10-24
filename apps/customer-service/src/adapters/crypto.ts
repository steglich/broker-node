import { createHash, randomInt } from 'node:crypto';
import type { BlindIndex, FieldCipher } from '@broker/persistence';
import type { FieldProtection, Randomness } from '../application/ports.js';

/** Cifra de campo e HMAC de busca do `@broker/persistence` (RN-DB-031). */
export class FieldProtectionAdapter implements FieldProtection {
  constructor(
    private readonly cipher: FieldCipher,
    private readonly index: BlindIndex,
  ) {}

  seal(value: string, context: string): string {
    return this.cipher.encrypt(value, context);
  }
  open(stored: string, context: string): string {
    return this.cipher.decrypt(stored, context);
  }
  hash(value: string, context: string): string {
    return this.index.hash(value, context);
  }
}

export const nodeRandomness: Randomness = {
  digits: (n) => Array.from({ length: n }, () => randomInt(10)).join(''),
  sha256: (value) => createHash('sha256').update(value).digest('hex'),
};
