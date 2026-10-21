// Relay da outbox rodando como processo separado. Com RELAY_CRASH=1, morre com SIGKILL depois
// de o broker confirmar a publicação e antes de marcar published_at (cenário do ADR-0008).
import { RealClock } from '@broker/clock';
import { createDatabase } from '@broker/persistence';
import { connectStream, OutboxRelay, PartitionedProducer } from '../../src/index.js';

const dbConfig = JSON.parse(process.env['RELAY_DB']!);
const stream = JSON.parse(process.env['RELAY_STREAM']!);
const db = createDatabase(dbConfig);
const client = await connectStream(stream, 'relay-fixture');
const producer = await PartitionedProducer.create(
  client,
  process.env['RELAY_SUPER_STREAM']!,
  process.env['RELAY_PUBLISHER_REF']!,
);

const relay = new OutboxRelay({
  db,
  listenConfig: dbConfig,
  producer,
  clock: new RealClock(),
  pollIntervalMs: 200,
  onError: (err) => console.error('RELAY_ERROR', err),
  afterPublish: (ids) => {
    console.log(`PUBLISHED ${ids.length}`);
    if (process.env['RELAY_CRASH'] === '1') process.kill(process.pid, 'SIGKILL');
  },
});
await relay.start();
console.log('STARTED');
