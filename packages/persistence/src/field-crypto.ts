import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Criptografia de campo (RN-DB-031, D18) com *envelope encryption*:
 *
 *   chave-mestra (KEK, Docker secret) ──cifra──► chave de dados (DEK, tabela data_key)
 *   chave de dados ──cifra──► valor do campo (ex.: CPF)
 *
 * A chave-mestra nunca vai para o banco; o banco só guarda a chave de dados cifrada. Trocar a
 * chave de dados (rotação) não exige trocar a mestra, e vice-versa. Os valores antigos continuam
 * legíveis porque cada valor cifrado leva o ID da chave que o cifrou.
 *
 * Algoritmo: AES-256-GCM (cifra autenticada: detecta adulteração), IV aleatório de 96 bits por
 * valor. O "contexto" (ex.: `customer.tax_id`) entra como dado autenticado (AAD): um valor
 * cifrado copiado para outra coluna não decifra.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 'v1';

/** Lê uma chave de 32 bytes em hex (64 caracteres) ou base64. */
export function parseKey(text: string, what = 'chave'): Buffer {
  const t = text.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (key.length !== KEY_BYTES) throw new Error(`${what} precisa ter ${KEY_BYTES} bytes`);
  return key;
}

/** Lê uma chave de um arquivo de segredo (`/run/secrets/...`). */
export const readKeyFile = (path: string, what?: string): Buffer =>
  parseKey(readFileSync(path, 'utf8'), what);

/** Gera uma chave nova (32 bytes) em hex, para os segredos locais. */
export const generateKeyHex = (): string => randomBytes(KEY_BYTES).toString('hex');

function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function open(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error('valor cifrado inválido');
  const decipher = createDecipheriv(ALGORITHM, key, sealed.subarray(0, IV_BYTES), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

/** Cifra uma chave de dados com a chave-mestra. */
export const wrapDataKey = (masterKey: Buffer, dataKey: Buffer): string =>
  seal(masterKey, dataKey, 'data_key').toString('base64');

/** Decifra uma chave de dados com a chave-mestra. Falha se a mestra estiver errada. */
export const unwrapDataKey = (masterKey: Buffer, wrapped: string): Buffer =>
  open(masterKey, Buffer.from(wrapped, 'base64'), 'data_key');

export interface Keyring {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

/** Cifra e decifra campos com as chaves de dados do serviço. */
export class FieldCipher {
  constructor(private readonly keyring: Keyring) {
    if (!keyring.keys.has(keyring.activeKeyId))
      throw new Error('a chave ativa não está no keyring');
  }

  /** Formato gravado: `v1.<keyId>.<base64url(iv | tag | texto cifrado)>`. */
  encrypt(plaintext: string, context: string): string {
    const key = this.keyring.keys.get(this.keyring.activeKeyId)!;
    const sealed = seal(key, Buffer.from(plaintext, 'utf8'), context);
    return `${FORMAT_VERSION}.${this.keyring.activeKeyId}.${sealed.toString('base64url')}`;
  }

  decrypt(stored: string, context: string): string {
    const [version, keyId, body] = stored.split('.');
    if (version !== FORMAT_VERSION || !keyId || !body)
      throw new Error('formato de valor cifrado desconhecido');
    const key = this.keyring.keys.get(keyId);
    if (!key) throw new Error(`chave de dados desconhecida: ${keyId}`);
    return open(key, Buffer.from(body, 'base64url'), context).toString('utf8');
  }

  /** ID da chave que cifrou o valor (para rotação: recifrar o que usa chave antiga). */
  static keyIdOf(stored: string): string | undefined {
    return stored.split('.')[1];
  }
}

/**
 * Hash com chave para busca exata sem decifrar (RN-DB-031: `tax_id_hash`). HMAC-SHA256 com chave
 * própria, diferente da de cifragem. Sem a chave, um atacante com o banco não consegue testar
 * os ~10^9 CPFs possíveis contra o hash, como faria com um SHA-256 simples.
 */
export class BlindIndex {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error(`a chave do HMAC precisa ter ${KEY_BYTES} bytes`);
  }

  /** `context` separa os índices de campos diferentes; `value` deve vir normalizado (ex.: só dígitos). */
  hash(value: string, context: string): string {
    return createHmac('sha256', this.key).update(context).update('\0').update(value).digest('hex');
  }

  matches(value: string, context: string, expected: string): boolean {
    const a = Buffer.from(this.hash(value, context), 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/** Migração da tabela das chaves de dados cifradas. */
export const dataKeyMigrations: Record<string, Migration> = {
  '0000_platform_data_key': {
    async up(db: Kysely<unknown>) {
      await sql`
        CREATE TABLE data_key (
          id           text PRIMARY KEY,
          wrapped_key  text NOT NULL,
          active       boolean NOT NULL,
          created_at   timestamptz NOT NULL DEFAULT now()
        )`.execute(db);
      // No máximo uma chave ativa por vez.
      await sql`CREATE UNIQUE INDEX data_key_single_active ON data_key (active) WHERE active`.execute(
        db,
      );
    },
    async down(db: Kysely<unknown>) {
      await sql`DROP TABLE IF EXISTS data_key`.execute(db);
    },
  },
};

interface DataKeyRow {
  id: string;
  wrapped_key: string;
  active: boolean;
}

async function insertDataKey(db: Kysely<unknown>, masterKey: Buffer): Promise<void> {
  await sql`UPDATE data_key SET active = false WHERE active`.execute(db);
  const id = `k${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  await sql`INSERT INTO data_key (id, wrapped_key, active) VALUES (${id}, ${wrapDataKey(masterKey, randomBytes(KEY_BYTES))}, true)`.execute(
    db,
  );
}

/**
 * Carrega as chaves de dados do serviço e decifra com a chave-mestra. Na primeira execução,
 * cria a primeira chave. Um advisory lock de transação evita que duas instâncias criem chaves
 * ao mesmo tempo.
 */
export async function loadKeyring(db: Kysely<unknown>, masterKey: Buffer): Promise<Keyring> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('broker.data_key'))`.execute(trx);
    let rows = (await sql<DataKeyRow>`SELECT id, wrapped_key, active FROM data_key`.execute(trx))
      .rows;
    if (rows.length === 0) {
      await insertDataKey(trx, masterKey);
      rows = (await sql<DataKeyRow>`SELECT id, wrapped_key, active FROM data_key`.execute(trx))
        .rows;
    }
    const active = rows.find((r) => r.active);
    if (!active) throw new Error('nenhuma chave de dados ativa');
    return {
      activeKeyId: active.id,
      keys: new Map(rows.map((r) => [r.id, unwrapDataKey(masterKey, r.wrapped_key)])),
    };
  });
}

/** Rotação: cria uma chave de dados nova e ativa; as antigas ficam só para decifrar. */
export async function rotateDataKey(db: Kysely<unknown>, masterKey: Buffer): Promise<Keyring> {
  await db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('broker.data_key'))`.execute(trx);
    await insertDataKey(trx, masterKey);
  });
  return loadKeyring(db, masterKey);
}
