import type { Client } from 'rabbitmq-stream-js-client';

/** Nome de tópico `<ambiente>.<contexto>.<tipo>` (RN-MSG-B-001): `sandbox.ledger.events`. */
export function topicName(
  environment: string,
  context: string,
  kind: 'events' | 'commands' = 'events',
): string {
  for (const part of [environment, context]) {
    if (!/^[a-z][a-z0-9-]*$/.test(part))
      throw new Error(`parte inválida no nome do tópico: ${part}`);
  }
  return `${environment}.${context}.${kind}`;
}

export interface SuperStreamOptions {
  /** Partições (D6: padrão local 3; a tabela de RN-MSG-B-002 vale para staging). */
  partitions?: number;
  /** Retenção por idade, ex.: `90D` (RN-MSG-B-002). */
  maxAge?: string;
  /** Retenção por tamanho de cada partição, em bytes. */
  maxLengthBytes?: number;
}

/** Cria o super stream se ainda não existir e devolve as partições em ordem. */
export async function ensureSuperStream(
  client: Client,
  name: string,
  options: SuperStreamOptions = {},
): Promise<string[]> {
  const existing = await client.partitionsQuery({ superStream: name }).catch(() => [] as string[]);
  if (existing.length > 0) return existing;
  await client.createSuperStream(
    {
      streamName: name,
      arguments: {
        ...(options.maxAge ? { 'max-age': options.maxAge } : {}),
        ...(options.maxLengthBytes ? { 'max-length-bytes': options.maxLengthBytes } : {}),
      },
    },
    undefined,
    options.partitions ?? 3,
  );
  return client.partitionsQuery({ superStream: name });
}
