// CLI do ambiente local: cadastra (ou alinha) os clientes de serviço com os segredos do cofre
// simulado, para os serviços obterem token por client credentials sem passar pelo backoffice.
// Uso: node dist/provision-clients.js [manifesto] [pasta dos segredos] (o `pnpm env:up` chama).
// O manifesto lista `{ "<client_id>": ["<escopo>", ...] }`; o segredo de cada um é o arquivo
// `<pasta>/<client_id>`, o mesmo que o serviço recebe como Docker secret.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wire } from './wiring.js';

const [manifest = '/etc/broker/service-clients.json', secretsDir = '/run/secrets/service-clients'] =
  process.argv.slice(2);
const clients = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, string[]>;

const { app, close } = await wire({ withStream: false });
try {
  for (const [clientId, scopes] of Object.entries(clients)) {
    const secret = readFileSync(join(secretsDir, clientId), 'utf8').trim();
    const result = await app.accounts.ensureServiceClient({ clientId, scopes, secret });
    console.log(`${clientId}: ${result}`);
  }
} finally {
  await close();
}
