import { activeTraceparent, withConsumerSpan, type Envelope } from '@broker/messaging';
import { SpanKind, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exporter = new InMemorySpanExporter();
const processor = new SimpleSpanProcessor(exporter);
let sdk: NodeSDK;
/** O SimpleSpanProcessor exporta de forma assíncrona: espera antes de ler. */
const finished = async () => {
  await processor.forceFlush();
  return exporter.getFinishedSpans();
};

beforeAll(() => {
  // SDK real (propagador W3C e contexto assíncrono), exportando em memória.
  sdk = new NodeSDK({ spanProcessors: [processor], instrumentations: [] });
  sdk.start();
});
afterAll(() => sdk.shutdown());

const envelope = (traceparent: string | undefined): Envelope => ({
  eventId: '0192a3c0-0000-7000-8000-000000000001',
  eventType: 'ledger.entry_posted',
  eventVersion: 1,
  source: 'ledger-service',
  environment: 'prod',
  occurredAt: '2026-10-16T13:00:00.000Z',
  partitionKey: 'acc-1',
  correlationId: 'corr-1',
  actor: { type: 'USER', id: 'u-1' },
  auditable: false,
  payload: {},
  ...(traceparent ? { traceparent } : {}),
});

describe('W3C Trace Context nas mensagens (RN-OBS §4)', () => {
  it('spec: o span do consumidor é filho do span HTTP que publicou o evento (mesmo trace)', async () => {
    const tracer = trace.getTracer('test');
    let published: Envelope | undefined;
    tracer.startActiveSpan('POST /v1/deposits', { kind: SpanKind.SERVER }, (span) => {
      // O EventPublisher grava activeTraceparent() no envelope quando o evento nasce na requisição.
      published = envelope(activeTraceparent());
      span.end();
    });
    expect(published!.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    // Outro processo, outro momento: o consumidor só tem o envelope.
    await withConsumerSpan('custody.projector', published!, async () => 'APPLIED');

    const spans = await finished();
    const http = spans.find((s) => s.name === 'POST /v1/deposits')!;
    const consumer = spans.find((s) => s.name === 'process ledger.entry_posted')!;
    expect(consumer.spanContext().traceId).toBe(http.spanContext().traceId);
    expect(consumer.parentSpanContext?.spanId).toBe(http.spanContext().spanId);
    expect(consumer.kind).toBe(SpanKind.CONSUMER);
    expect(consumer.attributes).toMatchObject({
      'messaging.consumer.group.name': 'custody.projector',
      'broker.outcome': 'APPLIED',
    });
  });

  it('evento sem traceparent inicia um trace novo, e erro do handler marca o span', async () => {
    await expect(
      withConsumerSpan('c', envelope(undefined), async () => Promise.reject(new Error('falhou'))),
    ).rejects.toThrow('falhou');
    const span = (await finished()).at(-1)!;
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.status.code).toBe(2); // ERROR
    expect(span.events.some((e) => e.name === 'exception')).toBe(true);
  });
});
