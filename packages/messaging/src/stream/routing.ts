/**
 * murmur3 32 bits com semente 104729: o mesmo roteamento `hash` dos clientes oficiais de super
 * stream do RabbitMQ (ADR-0001, achado 1). Produtor e qualquer outro cliente mandam a mesma chave
 * para a mesma partição.
 */
export function murmur32(key: string): number {
  const data = Buffer.from(key, 'utf8');
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h = 104729;
  const blocks = Math.floor(data.length / 4);
  for (let i = 0; i < blocks; i++) {
    let k = data.readUInt32LE(i * 4);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  // Bytes restantes (1 a 3), do mais alto para o mais baixo.
  const tail = blocks * 4;
  const rest = data.length & 3;
  if (rest > 0) {
    let k = 0;
    if (rest === 3) k ^= data[tail + 2]! << 16;
    if (rest >= 2) k ^= data[tail + 1]! << 8;
    k ^= data[tail]!;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
  }
  h ^= data.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Partição de uma chave: `murmur32(chave) mod n`. Chaves iguais caem sempre na mesma partição. */
export const partitionIndex = (key: string, partitions: number): number =>
  murmur32(key) % partitions;
