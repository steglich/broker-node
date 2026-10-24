// identity-service (catálogo de serviços §1): identidade e acesso dos realms customers e backoffice.
import { wire } from './wiring.js';

const { app, close } = await wire({ withStream: true });
app.service.onShutdown('identity', () => app.stop());
app.service.onShutdown('connections', close);
await app.start();
await app.service.start();
