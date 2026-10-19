import { randomBytes } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlindIndex,
  createDatabase,
  dataKeyMigrations,
  FieldCipher,
  generateKeyHex,
  loadKeyring,
  migrateToLatest,
  parseKey,
  rotateDataKey,
  unwrapDataKey,
  wrapDataKey,
} from '../src/index.js';
import { configFor } from './helpers.js';

const CPF = '52998224725';
const CTX = 'customer.tax_id';

describe('criptografia de campo sem banco (RN-DB-031)', () => {
  const keyring = { activeKeyId: 'k1', keys: new Map([['k1', randomBytes(32)]]) };
  const cipher = new FieldCipher(keyring);

  it('RN-DB-031: round-trip AES-256-GCM e IV novo a cada cifragem', () => {
    const a = cipher.encrypt(CPF, CTX);
    const b = cipher.encrypt(CPF, CTX);
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.k1.')).toBe(true);
    expect(a).not.toContain(CPF);
    expect(cipher.decrypt(a, CTX)).toBe(CPF);
    expect(cipher.decrypt(b, CTX)).toBe(CPF);
  });

  it('valor adulterado ou de outra coluna (AAD) não decifra', () => {
    const stored = cipher.encrypt(CPF, CTX);
    expect(() => cipher.decrypt(stored, 'customer.phone')).toThrow();
    const body = Buffer.from(stored.split('.')[2]!, 'base64url');
    body[body.length - 1]! ^= 1;
    expect(() => cipher.decrypt(`v1.k1.${body.toString('base64url')}`, CTX)).toThrow();
    expect(() => cipher.decrypt('v2.k1.abc', CTX)).toThrow(/formato/);
    expect(() => cipher.decrypt('v1.k9.abc', CTX)).toThrow(/desconhecida/);
  });

  it('envelope: a chave de dados só abre com a chave-mestra certa', () => {
    const master = randomBytes(32);
    const dataKey = randomBytes(32);
    const wrapped = wrapDataKey(master, dataKey);
    expect(unwrapDataKey(master, wrapped).equals(dataKey)).toBe(true);
    expect(() => unwrapDataKey(randomBytes(32), wrapped)).toThrow();
  });

  it('hash com chave (HMAC): determinístico, depende da chave e do contexto', () => {
    const index = new BlindIndex(randomBytes(32));
    expect(index.hash(CPF, CTX)).toBe(index.hash(CPF, CTX));
    expect(index.hash(CPF, CTX)).not.toBe(index.hash(CPF, 'other.field'));
    expect(index.hash(CPF, CTX)).not.toBe(new BlindIndex(randomBytes(32)).hash(CPF, CTX));
    expect(index.matches(CPF, CTX, index.hash(CPF, CTX))).toBe(true);
    expect(index.matches('11144477735', CTX, index.hash(CPF, CTX))).toBe(false);
  });

  it('lê chaves em hex ou base64 e recusa tamanho errado', () => {
    const hex = generateKeyHex();
    expect(parseKey(hex).length).toBe(32);
    expect(parseKey(Buffer.from(hex, 'hex').toString('base64')).toString('hex')).toBe(hex);
    expect(() => parseKey('abcd')).toThrow(/32 bytes/);
    expect(() => new BlindIndex(randomBytes(16))).toThrow();
  });
});

describe('criptografia de campo no banco (RN-DB-031)', () => {
  const master = randomBytes(32);
  const index = new BlindIndex(randomBytes(32));
  let migrator: Kysely<unknown>;
  let app: Kysely<unknown>;

  beforeAll(async () => {
    migrator = createDatabase(configFor('crypto', 'migrator'));
    app = createDatabase(configFor('crypto', 'app'));
    await migrateToLatest(migrator, {
      ...dataKeyMigrations,
      '0001_customer': {
        async up(db: Kysely<unknown>) {
          await sql`
            CREATE TABLE customer (
              id                uuid PRIMARY KEY,
              tax_id_encrypted  text NOT NULL,
              tax_id_hash       text NOT NULL UNIQUE
            )`.execute(db);
        },
      },
    });
  });

  afterAll(async () => {
    await Promise.all([migrator.destroy(), app.destroy()]);
  });

  it('RN-DB-031: o valor gravado está cifrado, a busca é pelo hash e o round-trip devolve o CPF', async () => {
    const cipher = new FieldCipher(await loadKeyring(app, master));
    await sql`
      INSERT INTO customer (id, tax_id_encrypted, tax_id_hash)
      VALUES ('0192a3c0-0000-7000-8000-000000000001', ${cipher.encrypt(CPF, CTX)}, ${index.hash(CPF, CTX)})`.execute(
      app,
    );

    // O que está no banco não contém o CPF, nem com nem sem máscara.
    const raw = await sql<{
      tax_id_encrypted: string;
      tax_id_hash: string;
    }>`SELECT * FROM customer`.execute(migrator);
    const stored = raw.rows[0]!;
    expect(stored.tax_id_encrypted).not.toContain(CPF);
    expect(stored.tax_id_encrypted).not.toContain('529.982');
    expect(stored.tax_id_hash).not.toContain(CPF);
    expect(stored.tax_id_encrypted).toMatch(/^v1\.k[0-9a-z]+\./);

    // Encontrar por CPF sem decifrar a tabela.
    const found = await sql<{ tax_id_encrypted: string }>`
      SELECT tax_id_encrypted FROM customer WHERE tax_id_hash = ${index.hash(CPF, CTX)}`.execute(
      app,
    );
    expect(cipher.decrypt(found.rows[0]!.tax_id_encrypted, CTX)).toBe(CPF);
  });

  it('D18: o banco só guarda a chave de dados cifrada, e a chave criada é reaproveitada', async () => {
    const first = await loadKeyring(app, master);
    const second = await loadKeyring(app, master);
    expect(second.activeKeyId).toBe(first.activeKeyId);
    const keys = await sql<{ wrapped_key: string }>`SELECT wrapped_key FROM data_key`.execute(app);
    expect(keys.rows).toHaveLength(1);
    expect(
      Buffer.from(keys.rows[0]!.wrapped_key, 'base64').includes(first.keys.get(first.activeKeyId)!),
    ).toBe(false);
    await expect(loadKeyring(app, randomBytes(32))).rejects.toThrow();
  });

  it('rotação: valores antigos continuam legíveis e os novos usam a chave nova', async () => {
    const before = await loadKeyring(app, master);
    const old = new FieldCipher(before).encrypt(CPF, CTX);
    const after = await rotateDataKey(app, master);
    expect(after.activeKeyId).not.toBe(before.activeKeyId);
    const cipher = new FieldCipher(after);
    expect(cipher.decrypt(old, CTX)).toBe(CPF);
    expect(FieldCipher.keyIdOf(cipher.encrypt(CPF, CTX))).toBe(after.activeKeyId);
    const active = await sql<{
      n: string;
    }>`SELECT count(*) AS n FROM data_key WHERE active`.execute(app);
    expect(Number(active.rows[0]!.n)).toBe(1);
  });
});
