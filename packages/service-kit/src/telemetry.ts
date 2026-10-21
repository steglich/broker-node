import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { AmqplibInstrumentation } from '@opentelemetry/instrumentation-amqplib';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion: string;
  environment: string;
  /** Endpoint OTLP/HTTP (o contêiner `grafana/otel-lgtm` em `http://lgtm:4318`). */
  endpoint: string;
  metricIntervalMs?: number;
}

/**
 * OpenTelemetry (D17, RN-OBS §4): traces e métricas exportados por OTLP para o otel-lgtm.
 * Instrumenta HTTP (entrada e saída), Express, `pg`, `amqplib` e `undici`; os consumidores de
 * streams criam os spans à mão a partir do `traceparent` do envelope (`@broker/messaging`).
 *
 * Em ESM, a instrumentação automática precisa ser carregada antes do código do serviço:
 * `node --import @broker/service-kit/telemetry dist/main.js` (ver `register.ts`).
 */
export function startTelemetry(options: TelemetryOptions): NodeSDK {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion,
      'deployment.environment.name': options.environment,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${options.endpoint}/v1/traces` }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${options.endpoint}/v1/metrics` }),
        exportIntervalMillis: options.metricIntervalMs ?? 15_000,
      }),
    ],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => req.url?.startsWith('/health') ?? false,
      }),
      new ExpressInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new AmqplibInstrumentation(),
      new UndiciInstrumentation(),
    ],
  });
  sdk.start();
  return sdk;
}
