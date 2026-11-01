// reference-data-service (catálogo de serviços §4): instrumentos, universo negociável, regras de
// negociação com vigência, histórico de tickers, calendário e grade horária.
import { wire } from './wiring.js';

const { app, close } = await wire({ withStream: true });
app.service.onShutdown('reference', () => app.stop());
app.service.onShutdown('connections', close);
await app.start();
await app.service.start();
