// Candidato a líder rodando como processo separado (usado pelo teste de eleição).
// Imprime ELECTED e REVOKED no stdout para o teste acompanhar.
import { LeaderElector } from '../../src/index.js';

const elector = new LeaderElector({
  database: JSON.parse(process.env['LEADER_DB']!),
  name: process.env['LEADER_NAME']!,
  heartbeatMs: 200,
  onElected: () => console.log('ELECTED'),
  onRevoked: (reason) => console.log(`REVOKED ${reason}`),
  onError: (err) => console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`),
});

await elector.start();
console.log('STARTED');
process.on('SIGTERM', () => void elector.stop().then(() => process.exit(0)));
