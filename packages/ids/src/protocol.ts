import { randomFillSync } from 'node:crypto';

/** Alfabeto Crockford base32: sem I, L, O e U, para não confundir na leitura (ditado ao suporte). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PROTOCOL_PATTERN = /^([A-Z]{2,4})-(\d{8})-([0-9A-HJKMNP-TV-Z]{8})$/;

export interface ProtocolOptions {
  randomFill?: (bytes: Uint8Array) => void;
}

/**
 * Protocolo legível ao cliente (RN-PAD-061), ex.: protocolo de saque `SAQ-20261019-7K3M9Q2X`.
 * Formato: prefixo do tipo, data de negócio `YYYYMMDD` e 8 caracteres Crockford base32
 * (40 bits aleatórios). Não é sequencial, para não permitir enumeração (RN-PAD-062).
 */
export function createProtocol(
  prefix: string,
  businessDate: string,
  options: ProtocolOptions = {},
): string {
  if (!/^[A-Z]{2,4}$/.test(prefix)) throw new Error(`prefixo de protocolo inválido: ${prefix}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate))
    throw new Error(`data precisa ser YYYY-MM-DD: ${businessDate}`);
  const bytes = new Uint8Array(5);
  (options.randomFill ?? ((b: Uint8Array) => void randomFillSync(b)))(bytes);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code = CROCKFORD[Number(bits & 31n)]! + code;
    bits >>= 5n;
  }
  return `${prefix}-${businessDate.replaceAll('-', '')}-${code}`;
}

export const isValidProtocol = (value: string): boolean => PROTOCOL_PATTERN.test(value);
