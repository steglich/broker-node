/**
 * Spike 5.1 (D6): super stream com 3 partições, publicação por chave, consumo com Single Active
 * Consumer (SAC) em duas instâncias, failover e releitura por offset, usando
 * `rabbitmq-stream-js-client` diretamente. O resultado está em docs/adr/0001-rabbitmq-streams.md.
 */
import {
  Client,
  Offset,
  type Publisher,
  type SuperStreamConsumer,
} from 'rabbitmq-stream-js-client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const SUPER_STREAM = 'spike.events';
const GROUP = 'spike-consumer';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(
  cond: () => boolean,
  timeoutMs = 20_000,
  what = 'condição',
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`tempo esgotado esperando ${what}`);
    await sleep(50);
  }
}

function connect(name: string): Promise<Client> {
  const { rabbit } = inject('broker');
  return Client.connect({
    hostname: rabbit.host,
    port: rabbit.streamPort,
    username: rabbit.user,
    password: rabbit.password,
    vhost: '/',
    connectionName: name,
    // O broker anuncia o hostname interno do contêiner; o address resolver força o endereço mapeado.
    addressResolver: { enabled: true, endpoint: { host: rabbit.host, port: rabbit.streamPort } },
  });
}

/** murmur3 32 bits, semente 104729: o mesmo roteamento `hash` dos clientes oficiais de super stream. */
function murmur32(key: string): number {
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
  let k = 0;
  const tail = blocks * 4;
  switch (data.length & 3) {
    case 3:
      k ^= data[tail + 2]! << 16;
    // falls through
    case 2:
      k ^= data[tail + 1]! << 8;
    // falls through
    case 1:
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

interface Received {
  instance: string;
  partition: string;
  key: string;
  seq: number;
  offset: bigint;
}

let admin: Client;
let partitions: string[];
const received: Received[] = [];
/** Offset processado por partição: simula a tabela consumer_offset gravada junto com o efeito. */
const storedOffsets = new Map<string, bigint>();
const instances = new Map<string, Client>();

/** Uma instância do serviço: um consumidor SAC por partição, no mesmo grupo (consumerRef). */
async function startInstance(name: string): Promise<void> {
  const client = await connect(name);
  instances.set(name, client);
  for (const partition of partitions) {
    await client.declareConsumer(
      {
        stream: partition,
        consumerRef: GROUP,
        offset: Offset.first(),
        singleActive: true,
        // Chamado quando esta instância vira a ativa da partição: retoma do offset salvo "no banco".
        consumerUpdateListener: async (_ref, stream) => {
          const last = storedOffsets.get(stream);
          return last === undefined ? Offset.first() : Offset.offset(last + 1n);
        },
      },
      (msg) => {
        const body = JSON.parse(msg.content.toString()) as { key: string; seq: number };
        received.push({
          instance: name,
          partition,
          key: body.key,
          seq: body.seq,
          offset: msg.offset!,
        });
        storedOffsets.set(partition, msg.offset!);
      },
      // Propriedade `super-stream`: o broker distribui as partições entre as instâncias do grupo.
      { superStream: SUPER_STREAM } as unknown as SuperStreamConsumer,
    );
  }
}

const publishers = new Map<string, Publisher>();
const pendingConfirms = new Map<string, Set<bigint>>();
const nextId = new Map<string, bigint>();

/** Publica com roteamento por chave e espera a confirmação do broker (publish_confirm). */
async function publish(key: string, seq: number): Promise<void> {
  const partition = partitions[murmur32(key) % partitions.length]!;
  const publisher = publishers.get(partition)!;
  const id = (nextId.get(partition) ?? 0n) + 1n;
  nextId.set(partition, id);
  pendingConfirms.get(partition)!.add(id);
  await publisher.basicSend(id, Buffer.from(JSON.stringify({ key, seq })), {
    applicationProperties: { partitionKey: key },
  });
}

async function publishBatch(keys: string[], seqs: number[]): Promise<void> {
  for (const seq of seqs) for (const key of keys) await publish(key, seq);
  for (const p of publishers.values()) await p.flush();
  await waitUntil(
    () => [...pendingConfirms.values()].every((s) => s.size === 0),
    10_000,
    'confirmações',
  );
}

const KEYS = Array.from({ length: 20 }, (_, i) => `account-${i}`);

beforeAll(async () => {
  admin = await connect('spike-admin');
  await admin.createSuperStream(
    { streamName: SUPER_STREAM, arguments: { 'max-age': '7D' } },
    undefined,
    3,
  );
  partitions = await admin.partitionsQuery({ superStream: SUPER_STREAM });
  for (const p of partitions) {
    // `publisherRef` liga a deduplicação no broker por publishingId.
    const publisher = await admin.declarePublisher({
      stream: p,
      publisherRef: `spike-publisher-${p}`,
    });
    pendingConfirms.set(p, new Set());
    publisher.on('publish_confirm', (err, ids) => {
      if (err === null) for (const id of ids) pendingConfirms.get(p)!.delete(id);
    });
    publishers.set(p, publisher);
  }
}, 60_000);

afterAll(async () => {
  for (const c of instances.values()) await c.close().catch(() => undefined);
  await admin?.close().catch(() => undefined);
});

describe('spike: RabbitMQ super streams + SAC (D6)', () => {
  it('cria o super stream com 3 partições', () => {
    expect(partitions).toEqual([`${SUPER_STREAM}-0`, `${SUPER_STREAM}-1`, `${SUPER_STREAM}-2`]);
  });

  it('roteamento murmur3 igual ao do cliente oficial e todas as partições recebem chaves', () => {
    const used = new Set(KEYS.map((k) => murmur32(k) % 3));
    expect(used.size).toBe(3);
  });

  it('duas instâncias: o broker distribui as partições e a ordem por chave é mantida', async () => {
    await startInstance('A');
    await startInstance('B');
    await sleep(500);
    await publishBatch(KEYS, [0, 1, 2, 3, 4]);
    await waitUntil(() => received.length === KEYS.length * 5, 20_000, 'mensagens');

    const byInstance = new Map<string, Set<string>>();
    for (const r of received)
      byInstance.set(r.instance, (byInstance.get(r.instance) ?? new Set()).add(r.partition));
    // Cada partição tem um único consumidor ativo...
    const owners = new Map<string, Set<string>>();
    for (const r of received)
      owners.set(r.partition, (owners.get(r.partition) ?? new Set()).add(r.instance));
    for (const s of owners.values()) expect(s.size).toBe(1);
    // ...e as duas instâncias trabalham (partições distribuídas pelo broker).
    expect(byInstance.size).toBe(2);

    for (const key of KEYS) {
      expect(received.filter((r) => r.key === key).map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
    }
  });

  it('failover: a instância que sobra assume as partições e retoma do offset salvo, sem perda nem duplicata', async () => {
    const before = received.length;
    await instances.get('A')!.close();
    instances.delete('A');
    await sleep(500);
    await publishBatch(KEYS, [5, 6, 7]);
    await waitUntil(
      () => received.length === before + KEYS.length * 3,
      20_000,
      'mensagens após failover',
    );

    const after = received.slice(before);
    expect(new Set(after.map((r) => r.instance))).toEqual(new Set(['B']));
    for (const key of KEYS) {
      expect(received.filter((r) => r.key === key).map((r) => r.seq)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7,
      ]);
    }
  });

  it('releitura: um consumidor novo relê a partição desde o início ou a partir de um offset', async () => {
    const partition = partitions[0]!;
    const inPartition = received.filter((r) => r.partition === partition);
    const replay: bigint[] = [];
    const fromFirst = await admin.declareConsumer(
      { stream: partition, offset: Offset.first() },
      (m) => {
        replay.push(m.offset!);
      },
    );
    await waitUntil(() => replay.length === inPartition.length, 10_000, 'releitura completa');

    const middle = inPartition[Math.floor(inPartition.length / 2)]!.offset;
    const partial: bigint[] = [];
    const fromOffset = await admin.declareConsumer(
      { stream: partition, offset: Offset.offset(middle) },
      (m) => {
        partial.push(m.offset!);
      },
    );
    await waitUntil(
      () => partial.length > 0 && partial.at(-1) === inPartition.at(-1)!.offset,
      10_000,
      'releitura parcial',
    );
    // Achado do spike: fechar o último consumidor de uma conexão encerra o socket, mas o pool do
    // cliente (1.1.0) ainda o reaproveita no próximo declareConsumer ("socket has been ended").
    // Por isso os dois consumidores de releitura são fechados só no fim.
    await admin.closeConsumer(fromOffset.extendedId);
    await admin.closeConsumer(fromFirst.extendedId);
    expect(partial[0]).toBe(middle);
  });

  it('deduplicação no broker: o mesmo publishingId com o mesmo publisherRef é descartado', async () => {
    const partition = partitions[0]!;
    const publisher = publishers.get(partition)!;
    const before = received.filter((r) => r.partition === partition).length;
    const id = (nextId.get(partition) ?? 0n) + 1n;
    nextId.set(partition, id);
    const body = Buffer.from(JSON.stringify({ key: 'dedup', seq: 0 }));
    await publisher.basicSend(id, body, {});
    await publisher.basicSend(id, body, {}); // reenvio (ex.: relay reiniciou antes de marcar)
    await publisher.flush();
    await sleep(1500);
    expect(received.filter((r) => r.partition === partition).length).toBe(before + 1);
  });
});
