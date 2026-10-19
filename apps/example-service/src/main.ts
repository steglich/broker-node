// Serviço mínimo: /health responde 200 só se a migração já rodou (a tabela existe).
import { createServer } from 'node:http';
import { connect } from './db.js';

const client = connect();
await client.connect();

const server = createServer((req, res) => {
  if (req.url !== '/health') {
    res.writeHead(404).end();
    return;
  }
  client
    .query<{ migrated_at: Date }>('SELECT migrated_at FROM migration_marker WHERE id = 1')
    .then(({ rows }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'UP', migratedAt: rows[0]?.migrated_at }));
    })
    .catch((err: unknown) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'DOWN', error: String(err) }));
    });
});

const port = Number(process.env['PORT'] ?? 8080);
server.listen(port, () => console.log(`example-service ouvindo em :${port}`));

const shutdown = () => server.close(() => void client.end().then(() => process.exit(0)));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
