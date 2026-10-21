import {
  context,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from '@opentelemetry/api';
import type { Envelope } from './envelope.js';

/**
 * Rastreio das mensagens (RN-OBS §4, D17) só com a API do OpenTelemetry: sem o SDK iniciado,
 * tudo vira no-op. O `traceparent` (W3C Trace Context) viaja dentro do envelope.
 */
const tracer = trace.getTracer('@broker/messaging');
const meter = metrics.getMeter('@broker/messaging');
const processed = meter.createCounter('messaging.consumer.messages', {
  description: 'Mensagens processadas por resultado',
});
const duration = meter.createHistogram('messaging.process.duration', {
  description: 'Duração do processamento',
  unit: 's',
});

/** `traceparent` do span ativo, para gravar no envelope ao publicar. */
export function activeTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier['traceparent'];
}

/** Executa o processamento num span de consumidor, filho do `traceparent` do envelope. */
export async function withConsumerSpan<T>(
  consumer: string,
  envelope: Envelope,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = envelope.traceparent
    ? propagation.extract(ROOT_CONTEXT, { traceparent: envelope.traceparent })
    : ROOT_CONTEXT;
  const started = performance.now();
  return tracer.startActiveSpan(
    `process ${envelope.eventType}`,
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        'messaging.system': 'rabbitmq',
        'messaging.operation.type': 'process',
        'messaging.consumer.group.name': consumer,
        'messaging.message.id': envelope.eventId,
        'messaging.destination.partition.id': envelope.partitionKey,
        'broker.event.type': envelope.eventType,
        'broker.correlation_id': envelope.correlationId,
      },
    },
    parent,
    async (span: Span) => {
      try {
        const result = await fn();
        span.setAttribute('broker.outcome', String(result));
        processed.add(1, { consumer, 'event.type': envelope.eventType, outcome: String(result) });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        processed.add(1, { consumer, 'event.type': envelope.eventType, outcome: 'ERROR' });
        throw err;
      } finally {
        duration.record((performance.now() - started) / 1000, {
          consumer,
          'event.type': envelope.eventType,
        });
        span.end();
      }
    },
  );
}
