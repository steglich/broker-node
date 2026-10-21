import { metrics } from '@opentelemetry/api';

/**
 * Métricas RED (RN-OBS §2): taxa, erros e duração por rota e status. Usam só a API do
 * OpenTelemetry: sem o SDK iniciado (ex.: testes), viram no-op.
 */
const meter = metrics.getMeter('@broker/service-kit');
const httpDuration = meter.createHistogram('http.server.request.duration', {
  description: 'Duração das requisições HTTP',
  unit: 's',
  advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] },
});

export function recordHttpRequest(
  method: string,
  route: string,
  status: number,
  durationMs: number,
): void {
  httpDuration.record(durationMs / 1000, {
    'http.request.method': method,
    'http.route': route,
    'http.response.status_code': status,
    ...(status >= 500 ? { 'error.type': String(status) } : {}),
  });
}
