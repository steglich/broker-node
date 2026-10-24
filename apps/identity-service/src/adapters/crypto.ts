import { argon2, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { BlindIndex, FieldCipher } from '@broker/persistence';
import type { FieldProtection, Randomness, SecretHasher } from '../application/ports.js';

const argon2Async = promisify(argon2);

export interface Argon2Params {
  /** Memória em KiB (padrão 19 MiB, a recomendação mínima da OWASP para argon2id). */
  memory: number;
  passes: number;
  parallelism: number;
}

export const DEFAULT_ARGON2: Argon2Params = { memory: 19_456, passes: 2, parallelism: 1 };

/**
 * argon2id do próprio Node (`crypto.argon2`, Node 24.7+), sem dependência nativa. Formato PHC:
 * `$argon2id$v=19$m=…,t=…,p=…$<sal>$<hash>`: os parâmetros viajam com o hash, então subir o custo
 * não invalida os hashes antigos (RN-AUTH-001: parâmetros revisados periodicamente).
 */
export class Argon2Hasher implements SecretHasher {
  private dummy: Promise<string> | undefined;

  constructor(private readonly params: Argon2Params = DEFAULT_ARGON2) {}

  async hash(secret: string): Promise<string> {
    const nonce = randomBytes(16);
    const tag = await this.derive(secret, nonce, this.params);
    const { memory: m, passes: t, parallelism: p } = this.params;
    return `$argon2id$v=19$m=${m},t=${t},p=${p}$${nonce.toString('base64url')}$${tag.toString('base64url')}`;
  }

  async verify(stored: string, secret: string): Promise<boolean> {
    const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored);
    if (!match) return false;
    const [, m, t, p, nonce, tag] = match;
    const expected = Buffer.from(tag!, 'base64url');
    const actual = await this.derive(secret, Buffer.from(nonce!, 'base64url'), {
      memory: Number(m),
      passes: Number(t),
      parallelism: Number(p),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async burn(): Promise<void> {
    this.dummy ??= this.hash('senha-que-ninguem-tem');
    await this.verify(await this.dummy, 'outra-senha-qualquer');
  }

  private derive(secret: string, nonce: Buffer, params: Argon2Params): Promise<Buffer> {
    return argon2Async('argon2id', {
      message: Buffer.from(secret.normalize('NFC'), 'utf8'),
      nonce,
      parallelism: params.parallelism,
      tagLength: 32,
      memory: params.memory,
      passes: params.passes,
    });
  }
}

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
  emailHash(email: string): string {
    return this.index.hash(email, 'user.email');
  }
  ipHash(ip: string): string {
    return this.index.hash(ip, 'ip').slice(0, 16);
  }
}

export const nodeRandomness: Randomness = {
  // 256 bits: refresh tokens, códigos de autorização e links não são adivinháveis.
  token: () => randomBytes(32).toString('base64url'),
  digits: (n) => Array.from({ length: n }, () => randomInt(10)).join(''),
  sha256: (value) => createHash('sha256').update(value).digest('hex'),
};
