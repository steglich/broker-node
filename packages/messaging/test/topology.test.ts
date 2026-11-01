import { connect } from 'amqplib';
import { inject } from 'vitest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'rabbitmq-stream-js-client';
import { connectStream, ensureSuperStream } from '../src/index.js';
import { amqpUrl, streamSettings } from './stream-fixture.js';
import { newId } from './helpers.js';

// Com a porta AMQP, a topologia é declarada peça por peça (idempotente); sem ela, pelo comando
// `create_super_stream` do protocolo de streams.
const clients: Client[] = [];
const connectWithAmqp = async () => {
  const c = await connectStream(
    { ...streamSettings(), amqpPort: inject('broker').rabbit.amqpPort },
    `topology-test-${newId()}`,
  );
  clients.push(c);
  return c;
};

let a: Client;
let b: Client;
beforeAll(async () => {
  [a, b] = await Promise.all([connectWithAmqp(), connectWithAmqp()]);
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

describe('ensureSuperStream', () => {
  it('dois serviços garantindo o mesmo tópico ao mesmo tempo terminam com as mesmas partições', async () => {
    const name = `test.topology-${newId()}.events`;
    const [pa, pb] = await Promise.all([
      ensureSuperStream(a, name, { partitions: 3, maxAge: '30D' }),
      ensureSuperStream(b, name, { partitions: 3, maxAge: '30D' }),
    ]);
    const expected = [`${name}-0`, `${name}-1`, `${name}-2`];
    expect(pa).toEqual(expected);
    expect(pb).toEqual(expected);
    // Mais uma vez: nada muda.
    expect(await ensureSuperStream(a, name, { partitions: 3 })).toEqual(expected);
  });

  it('conserta um tópico que perdeu a exchange (partições órfãs da corrida do create_super_stream)', async () => {
    const name = `test.topology-${newId()}.events`;
    await ensureSuperStream(a, name, { partitions: 2 });
    const connection = await connect(amqpUrl());
    const channel = await connection.createChannel();
    await channel.deleteExchange(name);
    await connection.close();
    expect(await a.partitionsQuery({ superStream: name }).catch(() => [])).toEqual([]);

    expect(await ensureSuperStream(b, name, { partitions: 2 })).toEqual([`${name}-0`, `${name}-1`]);
  });
});
