/**
 * Carregado com `node --import @broker/service-kit/telemetry`: registra o hook de ESM do
 * OpenTelemetry e inicia o SDK antes do código do serviço, para a instrumentação automática
 * conseguir interceptar `express`, `pg`, `amqplib` e `undici`.
 *
 * Variáveis: OTEL_EXPORTER_OTLP_ENDPOINT (sem ela, a telemetria fica desligada), SERVICE_NAME,
 * SERVICE_VERSION e ENVIRONMENT.
 */
import { register } from 'node:module';
import { createAddHookMessageChannel } from 'import-in-the-middle';

const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
if (endpoint) {
  const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel();
  register('import-in-the-middle/hook.mjs', import.meta.url, registerOptions);
  const { startTelemetry } = await import('./telemetry.js');
  const sdk = startTelemetry({
    serviceName: process.env['SERVICE_NAME'] ?? 'unknown-service',
    serviceVersion: process.env['SERVICE_VERSION'] ?? '0.0.0',
    environment: process.env['ENVIRONMENT'] ?? 'local',
    endpoint,
    metricIntervalMs: Number(process.env['OTEL_METRIC_EXPORT_INTERVAL'] ?? 15_000),
  });
  await waitForAllMessagesAcknowledged();
  const flush = () => void sdk.shutdown().catch(() => undefined);
  process.once('beforeExit', flush);
  process.once('SIGTERM', flush);
}
