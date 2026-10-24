import { cpfCheckDigit, type Instant } from '@broker/domain-kernel';

/**
 * `end_to_end_id` (RN-PIXS-001): 32 caracteres no espírito do padrão do PIX (`E` + instituição +
 * data/hora + sequência), mas com o prefixo `ESIM` no lugar do ISPB, para nunca ser confundido com
 * um identificador real. A sequência vem de uma SEQUENCE do banco: única mesmo entre instâncias.
 */
export function endToEndId(at: Instant, sequence: bigint): string {
  const stamp = at.toString().replace(/[-:T]/g, '').slice(0, 14);
  return `ESIM${stamp}${sequence.toString(36).padStart(14, '0')}`;
}

/** "Maria da Silva Souza" → "Maria S*** S***": o primeiro nome e as iniciais dos demais. */
export function maskName(name: string): string {
  const [first, ...rest] = name.trim().split(/\s+/);
  const particles = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
  return [
    first,
    ...rest.filter((w) => !particles.has(w.toLowerCase())).map((w) => `${w[0]!.toUpperCase()}***`),
  ].join(' ');
}

/** CPF válido a partir de uma base de 9 dígitos (para as contas de terceiros semeadas). */
export function cpfFromBase(base: string): string {
  const dv1 = cpfCheckDigit(base);
  return `${base}${dv1}${cpfCheckDigit(`${base}${dv1}`)}`;
}

function crc16(payload: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(payload, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/**
 * Payload "copia e cola" no formato EMV do BR Code (TLV + CRC16-CCITT), com GUI `br.sim.pix` no
 * lugar de `br.gov.bcb.pix`: o formato é realista, mas nenhum app de banco real aceita pagar.
 */
export function brCode(input: {
  key: string;
  amount: string;
  merchant: string;
  city: string;
  txid: string;
}): string {
  const body =
    tlv('00', '01') +
    tlv('26', tlv('00', 'br.sim.pix') + tlv('01', input.key)) +
    tlv('52', '0000') +
    tlv('53', '986') +
    tlv('54', input.amount) +
    tlv('58', 'BR') +
    tlv('59', input.merchant.slice(0, 25)) +
    tlv('60', input.city.slice(0, 15)) +
    tlv('62', tlv('05', input.txid)) +
    '6304';
  return body + crc16(body);
}
