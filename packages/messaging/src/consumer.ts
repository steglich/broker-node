import { sql, type Kysely } from 'kysely';
import type { ConsumeMessage } from 'amqplib';
import { Offset, type Client } from 'rabbitmq-stream-js-client';

// A biblioteca não exporta estes tipos; derivados da assinatura pública de declareConsumer.
type Message = Parameters<Parameters<Client['declareConsumer']>[1]>[0];
type SuperStreamConsumer = NonNullable<Parameters<Client['declareConsumer']>[2]>;
import { assertQuorumQueue, sendConfirmed, type AmqpSession } from './amqp.js';
import { parseEnvelope, type Envelope } from './envelope.js';
import { InvalidMessageError, isPermanent } from './errors.js';
import type { EventDefinition } from './events.js';
import { SerialQueue } from './serial-queue.js';
import { connectStream, type StreamSettings } from './stream/connection.js';
import { validationErrors } from './validation.js';

export interface EventHandler {
  /** Esquema e versão aceitos. Outras versões do mesmo `eventType` são ignoradas (RN-MSG-B-021). */
  definition?: EventDefinition;
  /** Aplica o efeito. Roda dentro da transação que também grava a inbox e o offset (RN-MSG-B-030/031). */
  handle(trx: Kysely<unknown>, envelope: Envelope): Promise<void>;
}

export interface RetryOptions {
  amqp: AmqpSession;
  /** Atrasos das retentativas (RN-MSG-B-033): padrão 1 min, 10 min e 1 h. */
  delaysMs?: readonly [number, number, number];
}

export interface CriticalAlert {
  consumer: string;
  partitionKey: string;
  deadLetterId: string;
  error: string;
}

export interface EventConsumerOptions {
  /** Nome do consumidor: grupo SAC, chave da inbox e prefixo das filas (ex.: `custody.projector`). */
  name: string;
  environment: string;
  superStream: string;
  stream: StreamSettings;
  /** Conexão da aplicação (`<svc>_app`) com as migrações-base aplicadas. */
  db: Kysely<unknown>;
  handlers: Readonly<Record<string, EventHandler>>;
  /** Fluxo em que a ordem importa (ledger, custódia, ordens, Motor): DLQ e retentativa bloqueiam a chave. */
  ordered: boolean;
  newId: () => string;
  retry?: RetryOptions;
  /** Tentativas locais antes da retentativa atrasada (RN-MSG-B-033): padrão 5. */
  localAttempts?: number;
  /** Backoff exponencial das tentativas locais: padrão de 100 ms a 5 s. */
  backoff?: { initialMs: number; maxMs: number };
  /** Onde um consumidor novo começa: `first` (reconstrói tudo) ou `next` (só o que chegar). */
  startFrom?: 'first' | 'next';
  /** Alerta crítico quando uma chave fica bloqueada por mensagem na DLQ (RN-MSG-B-035). */
  onCriticalAlert?: (alert: CriticalAlert) => void;
  onError?: (err: unknown) => void;
}

interface Origin {
  stream: string;
  partition: number;
  offset: bigint;
}

interface BlockedKeyRow {
  partition_key: string;
  dead_letter_id: string | null;
  event_id: string | null;
  reason: 'RETRYING' | 'DEAD_LETTER';
}

interface DeadLetterRow {
  id: string;
  partition_key: string | null;
  payload: unknown;
  status: string;
  attempts: number;
}

type Outcome = 'APPLIED' | 'DUPLICATE' | 'PARKED' | 'IGNORED' | 'RETRYING' | 'DEAD_LETTERED';

interface ProcessContext {
  origin?: Origin;
  /** Só o caminho do stream confere o bloqueio; retentativa, estacionadas e DLQ são o próprio desbloqueio. */
  checkBlocked: boolean;
  /** A mensagem assume o bloqueio da chave se falhar (retentativa e reprocessamento de estacionadas). */
  takeOverBlock: boolean;
  /** Linha de `parked_message` a apagar quando a mensagem for resolvida. */
  parkedId?: bigint;
  /** Estágio de retentativa atrasada em que a mensagem está (0 = ainda no caminho do stream). */
  stage: number;
  /** Executado na transação do efeito (ex.: marcar a DLQ como reprocessada). */
  afterApply?: (trx: Kysely<unknown>) => Promise<void>;
}

const RETRY_LABELS = ['1m', '10m', '1h'] as const;
const DEFAULT_DELAYS = [60_000, 600_000, 3_600_000] as const;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Consumidor de eventos de um super stream (RN-MSG-B-030..036, D6).
 *
 * - **SAC por partição**: em várias instâncias, cada partição tem um único consumidor ativo; quem
 *   assume retoma do offset salvo em `consumer_offset` (ADR-0001, achado 2).
 * - **Efeito exatamente uma vez**: inbox (`processed_event`), efeito e offset na mesma transação.
 * - **Em série por partição** (RN-MSG-B-032), com fila própria (ADR-0001, achado 4).
 * - **Retentativas** (RN-MSG-B-033/034): 5 locais com backoff; depois filas quorum `retry.1m`,
 *   `retry.10m` e `retry.1h`; depois DLQ. Erro permanente vai direto para a DLQ.
 * - **Bloqueio por chave** (RN-MSG-B-035, design D6): em consumidor ordenado, a chave é bloqueada
 *   quando a mensagem sai para a retentativa ou para a DLQ; as seguintes ficam em `parked_message`
 *   e são reprocessadas em ordem quando a chave é liberada.
 */
export class EventConsumer {
  private client: Client | undefined;
  private readonly queues = new Map<number, SerialQueue>();
  private retryConsumerTag: string | undefined;
  private readonly localAttempts: number;
  private readonly backoff: { initialMs: number; maxMs: number };
  private readonly delays: readonly number[];

  constructor(private readonly options: EventConsumerOptions) {
    this.localAttempts = options.localAttempts ?? 5;
    this.backoff = options.backoff ?? { initialMs: 100, maxMs: 5000 };
    this.delays = options.retry?.delaysMs ?? DEFAULT_DELAYS;
  }

  get name(): string {
    return this.options.name;
  }

  get ordered(): boolean {
    return this.options.ordered;
  }

  /** Nomes das filas AMQP deste consumidor. */
  queueNames(): { retry: string[]; ret: string; dlq: string } {
    const base = `${this.options.environment}.${this.options.name}`;
    return {
      retry: RETRY_LABELS.map((l) => `${base}.retry.${l}`),
      ret: `${base}.retry.return`,
      dlq: `${base}.dlq`,
    };
  }

  async start(): Promise<void> {
    const { superStream } = this.options;
    if (this.options.retry) await this.startRetryWorker(this.options.retry.amqp);

    this.client = await connectStream(this.options.stream, `consumer:${this.options.name}`);
    const partitions = await this.client.partitionsQuery({ superStream });
    if (partitions.length === 0) throw new Error(`super stream não existe: ${superStream}`);
    const initial = this.options.startFrom === 'next' ? Offset.next() : Offset.first();

    for (const partitionStream of partitions) {
      const partition = Number(partitionStream.slice(superStream.length + 1));
      const queue = new SerialQueue();
      this.queues.set(partition, queue);
      await this.client.declareConsumer(
        {
          stream: partitionStream,
          consumerRef: this.options.name,
          offset: initial,
          singleActive: true,
          // Ao virar a instância ativa da partição, retoma do offset gravado no banco do serviço.
          consumerUpdateListener: async () => {
            const saved = await this.savedOffset(partition);
            return saved === undefined ? initial : Offset.offset(saved + 1n);
          },
        },
        (msg) => {
          void queue
            .push(() => this.fromStream(partition, msg))
            .catch((err: unknown) => this.options.onError?.(err));
        },
        // Liga a propriedade `super-stream`: o broker distribui as partições entre as instâncias
        // do grupo (ADR-0001, achado 2). Único ponto que usa este parâmetro interno da biblioteca.
        { superStream } as unknown as SuperStreamConsumer,
      );
    }
  }

  /** Para de consumir e espera o que já estava em processamento. */
  async stop(): Promise<void> {
    if (this.retryConsumerTag) {
      await this.options.retry!.amqp.channel.cancel(this.retryConsumerTag).catch(() => undefined);
      this.retryConsumerTag = undefined;
    }
    // Fecha o cliente inteiro: fechar só os consumidores quebra o pool (ADR-0001, achado 3).
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    await Promise.all([...this.queues.values()].map((q) => q.idle()));
    this.queues.clear();
  }

  // ------------------------------------------------------------------ caminho do stream

  private async fromStream(partition: number, msg: Message): Promise<void> {
    const origin: Origin = { stream: this.options.superStream, partition, offset: msg.offset! };
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(msg.content, this.options.environment);
    } catch (err) {
      const key = msg.applicationProperties?.['partitionKey'];
      await this.deadLetter({
        raw: msg.content.toString('utf8'),
        error: err,
        attempts: 0,
        ctx: { origin, checkBlocked: false, takeOverBlock: false, stage: 0 },
        ...(typeof key === 'string' ? { partitionKey: key } : {}),
      });
      return;
    }
    await this.process(envelope, {
      origin,
      checkBlocked: this.options.ordered,
      takeOverBlock: false,
      stage: 0,
    });
  }

  private handlerFor(envelope: Envelope): EventHandler | undefined {
    const handler = this.options.handlers[envelope.eventType];
    if (!handler) return undefined;
    if (handler.definition && handler.definition.eventVersion !== envelope.eventVersion)
      return undefined;
    return handler;
  }

  /** Tentativas locais com backoff; esgotadas, segue para a retentativa atrasada (ou DLQ). */
  private async process(envelope: Envelope, ctx: ProcessContext): Promise<Outcome> {
    const handler = this.handlerFor(envelope);
    if (!handler) {
      // Evento que este consumidor não trata: só avança o offset.
      if (ctx.origin)
        await this.options.db.transaction().execute((trx) => this.commitOffset(trx, ctx.origin!));
      return 'IGNORED';
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.localAttempts; attempt++) {
      try {
        return await this.options.db
          .transaction()
          .execute((trx) => this.applyOnce(trx, envelope, handler, ctx));
      } catch (err) {
        if (isPermanent(err)) {
          await this.deadLetter({ envelope, error: err, attempts: attempt, ctx });
          return 'DEAD_LETTERED';
        }
        lastError = err;
        if (attempt < this.localAttempts) {
          await sleep(Math.min(this.backoff.initialMs * 2 ** (attempt - 1), this.backoff.maxMs));
        }
      }
    }
    if (this.options.retry && ctx.stage < this.delays.length) {
      await this.toRetry(envelope, ctx.stage + 1, lastError, ctx);
      return 'RETRYING';
    }
    await this.deadLetter({ envelope, error: lastError, attempts: this.localAttempts, ctx });
    return 'DEAD_LETTERED';
  }

  /** Uma tentativa: bloqueio → inbox → efeito → offset, numa transação só. */
  private async applyOnce(
    trx: Kysely<unknown>,
    envelope: Envelope,
    handler: EventHandler,
    ctx: ProcessContext,
  ): Promise<Outcome> {
    const { name } = this.options;
    if (ctx.checkBlocked) {
      // FOR UPDATE serializa com a liberação da chave (releaseKey): ou estaciona antes dela
      // terminar, ou vê a chave já livre e processa depois das estacionadas.
      const blocked = await sql`
        SELECT 1 FROM blocked_key WHERE consumer = ${name} AND partition_key = ${envelope.partitionKey} FOR UPDATE`.execute(
        trx,
      );
      if (blocked.rows.length > 0) {
        const o = ctx.origin!;
        await sql`
          INSERT INTO parked_message (consumer, partition_key, stream, partition, "offset", event_id, payload)
          VALUES (${name}, ${envelope.partitionKey}, ${o.stream}, ${o.partition}, ${o.offset}, ${envelope.eventId}, ${JSON.stringify(envelope)}::jsonb)`.execute(
          trx,
        );
        await this.commitOffset(trx, o);
        return 'PARKED';
      }
    }

    const inserted = await sql`
      INSERT INTO processed_event (event_id, consumer) VALUES (${envelope.eventId}, ${name})
      ON CONFLICT DO NOTHING RETURNING event_id`.execute(trx);
    const fresh = inserted.rows.length > 0;
    if (fresh) {
      if (handler.definition) {
        const errors = validationErrors(handler.definition.payload, envelope.payload);
        if (errors.length > 0)
          throw new InvalidMessageError(`payload fora do esquema: ${errors.join('; ')}`);
      }
      await handler.handle(trx, envelope);
    }
    if (ctx.origin) await this.commitOffset(trx, ctx.origin);
    if (ctx.parkedId !== undefined)
      await sql`DELETE FROM parked_message WHERE id = ${ctx.parkedId}`.execute(trx);
    await ctx.afterApply?.(trx);
    return fresh ? 'APPLIED' : 'DUPLICATE';
  }

  private async commitOffset(trx: Kysely<unknown>, origin: Origin): Promise<void> {
    await sql`
      INSERT INTO consumer_offset (consumer, stream, partition, "offset")
      VALUES (${this.options.name}, ${origin.stream}, ${origin.partition}, ${origin.offset})
      ON CONFLICT (consumer, stream, partition)
      DO UPDATE SET "offset" = GREATEST(consumer_offset."offset", EXCLUDED."offset"), updated_at = now()`.execute(
      trx,
    );
  }

  private async savedOffset(partition: number): Promise<bigint | undefined> {
    const { rows } = await sql<{ offset: bigint }>`
      SELECT "offset" FROM consumer_offset
      WHERE consumer = ${this.options.name} AND stream = ${this.options.superStream} AND partition = ${partition}`.execute(
      this.options.db,
    );
    return rows[0]?.offset;
  }

  // ------------------------------------------------------------------ retentativa atrasada

  private async startRetryWorker(amqp: AmqpSession): Promise<void> {
    const { retry, ret, dlq } = this.queueNames();
    await assertQuorumQueue(amqp.channel, ret);
    await assertQuorumQueue(amqp.channel, dlq);
    for (let i = 0; i < retry.length; i++) {
      await assertQuorumQueue(amqp.channel, retry[i]!, {
        ttlMs: this.delays[i]!,
        deadLetterTo: ret,
      });
    }
    await amqp.channel.prefetch(1);
    const { consumerTag } = await amqp.channel.consume(ret, (msg) => {
      if (msg) void this.fromRetry(amqp, msg).catch((err: unknown) => this.options.onError?.(err));
    });
    this.retryConsumerTag = consumerTag;
  }

  /**
   * Publica a mensagem na fila de atraso do estágio e, num consumidor ordenado, bloqueia a chave
   * (design D6). A fila é confirmada antes do commit: se cair no meio, a mensagem é relida do
   * stream e a inbox evita efeito duplicado.
   */
  private async toRetry(
    envelope: Envelope,
    stage: number,
    error: unknown,
    ctx: ProcessContext,
  ): Promise<void> {
    const amqp = this.options.retry!.amqp;
    await sendConfirmed(
      amqp.channel,
      this.queueNames().retry[stage - 1]!,
      Buffer.from(JSON.stringify(envelope)),
      {
        messageId: envelope.eventId,
        headers: { 'x-broker-stage': stage, 'x-broker-error': errorText(error).slice(0, 500) },
      },
    );
    await this.options.db.transaction().execute(async (trx) => {
      if (this.options.ordered) {
        if (ctx.takeOverBlock) {
          await sql`
            INSERT INTO blocked_key (consumer, partition_key, event_id, reason)
            VALUES (${this.options.name}, ${envelope.partitionKey}, ${envelope.eventId}, 'RETRYING')
            ON CONFLICT (consumer, partition_key)
            DO UPDATE SET event_id = EXCLUDED.event_id, reason = 'RETRYING', dead_letter_id = NULL, blocked_at = now()`.execute(
            trx,
          );
        } else {
          await sql`
            INSERT INTO blocked_key (consumer, partition_key, event_id, reason)
            VALUES (${this.options.name}, ${envelope.partitionKey}, ${envelope.eventId}, 'RETRYING')
            ON CONFLICT DO NOTHING`.execute(trx);
        }
      }
      if (ctx.origin) await this.commitOffset(trx, ctx.origin);
      if (ctx.parkedId !== undefined)
        await sql`DELETE FROM parked_message WHERE id = ${ctx.parkedId}`.execute(trx);
    });
  }

  /** Volta de uma fila de atraso: uma tentativa por estágio; deu certo, libera a chave. */
  private async fromRetry(amqp: AmqpSession, msg: ConsumeMessage): Promise<void> {
    const stage = Number(msg.properties.headers?.['x-broker-stage'] ?? 1);
    const envelope = JSON.parse(msg.content.toString('utf8')) as Envelope;
    const handler = this.handlerFor(envelope);
    if (handler) {
      const ctx: ProcessContext = { checkBlocked: false, takeOverBlock: true, stage };
      try {
        await this.options.db
          .transaction()
          .execute((trx) => this.applyOnce(trx, envelope, handler, ctx));
        if (this.options.ordered) {
          await this.releaseKey(
            envelope.partitionKey,
            (b) => b.reason === 'RETRYING' && b.event_id === envelope.eventId,
          );
        }
      } catch (err) {
        if (!isPermanent(err) && stage < this.delays.length)
          await this.toRetry(envelope, stage + 1, err, ctx);
        else
          await this.deadLetter({
            envelope,
            error: err,
            attempts: this.localAttempts + stage,
            ctx,
          });
      }
    }
    amqp.channel.ack(msg);
  }

  // ------------------------------------------------------------------ DLQ e bloqueio

  private async deadLetter(args: {
    envelope?: Envelope;
    raw?: string;
    partitionKey?: string;
    error: unknown;
    attempts: number;
    ctx: ProcessContext;
  }): Promise<string> {
    const { name } = this.options;
    const { envelope, ctx } = args;
    const id = this.options.newId();
    const key = envelope?.partitionKey ?? args.partitionKey ?? null;
    const payload = envelope ?? { raw: args.raw ?? '' };
    let blockedByThis = false;

    await this.options.db.transaction().execute(async (trx) => {
      await sql`
        INSERT INTO dead_letter (id, consumer, stream, partition, "offset", event_id, event_type, partition_key, payload, error, attempts)
        VALUES (${id}, ${name}, ${ctx.origin?.stream ?? this.options.superStream}, ${ctx.origin?.partition ?? null},
                ${ctx.origin?.offset ?? null}, ${envelope?.eventId ?? null}, ${envelope?.eventType ?? null}, ${key},
                ${JSON.stringify(payload)}::jsonb, ${errorText(args.error)}, ${args.attempts})`.execute(
        trx,
      );
      if (this.options.ordered && key !== null) {
        const res = ctx.takeOverBlock
          ? await sql`
              INSERT INTO blocked_key (consumer, partition_key, dead_letter_id, reason)
              VALUES (${name}, ${key}, ${id}, 'DEAD_LETTER')
              ON CONFLICT (consumer, partition_key)
              DO UPDATE SET dead_letter_id = EXCLUDED.dead_letter_id, reason = 'DEAD_LETTER', event_id = NULL, blocked_at = now()`.execute(
              trx,
            )
          : await sql`
              INSERT INTO blocked_key (consumer, partition_key, dead_letter_id, reason)
              VALUES (${name}, ${key}, ${id}, 'DEAD_LETTER')
              ON CONFLICT DO NOTHING`.execute(trx);
        blockedByThis = Number(res.numAffectedRows ?? 0n) > 0;
      }
      if (ctx.origin) await this.commitOffset(trx, ctx.origin);
      if (ctx.parkedId !== undefined)
        await sql`DELETE FROM parked_message WHERE id = ${ctx.parkedId}`.execute(trx);
    });

    // Cópia na fila DLQ do RabbitMQ (o banco é a fonte; a fila serve a alertas e inspeção).
    if (this.options.retry) {
      await sendConfirmed(
        this.options.retry.amqp.channel,
        this.queueNames().dlq,
        Buffer.from(JSON.stringify(payload)),
        {
          messageId: id,
          headers: { 'x-broker-error': errorText(args.error).slice(0, 500) },
        },
      ).catch((err: unknown) => this.options.onError?.(err));
    }
    if (blockedByThis && key !== null) {
      this.options.onCriticalAlert?.({
        consumer: name,
        partitionKey: key,
        deadLetterId: id,
        error: errorText(args.error),
      });
    }
    return id;
  }

  /**
   * Libera a chave se ela ainda estiver bloqueada pelo mesmo motivo (`isBlocker`): reprocessa as
   * mensagens estacionadas em ordem e só então apaga o bloqueio. Se uma estacionada falhar, ela
   * assume o bloqueio (retentativa ou DLQ) e a liberação para ali.
   */
  async releaseKey(partitionKey: string, isBlocker: (b: BlockedKeyRow) => boolean): Promise<void> {
    const { name } = this.options;
    for (;;) {
      const next = await this.options.db.transaction().execute(async (trx) => {
        const block = (
          await sql<BlockedKeyRow>`
            SELECT partition_key, dead_letter_id, event_id, reason FROM blocked_key
            WHERE consumer = ${name} AND partition_key = ${partitionKey} FOR UPDATE`.execute(trx)
        ).rows[0];
        if (!block || !isBlocker(block)) return undefined;
        const parked = (
          await sql<{ id: bigint; payload: Envelope }>`
            SELECT id, payload FROM parked_message
            WHERE consumer = ${name} AND partition_key = ${partitionKey} ORDER BY id LIMIT 1`.execute(
            trx,
          )
        ).rows[0];
        if (!parked) {
          await sql`DELETE FROM blocked_key WHERE consumer = ${name} AND partition_key = ${partitionKey}`.execute(
            trx,
          );
          return undefined;
        }
        return parked;
      });
      if (!next) return;
      const outcome = await this.process(next.payload, {
        checkBlocked: false,
        takeOverBlock: true,
        parkedId: next.id,
        stage: 0,
      });
      if (outcome === 'RETRYING' || outcome === 'DEAD_LETTERED') return;
      if (outcome === 'IGNORED')
        await sql`DELETE FROM parked_message WHERE id = ${next.id}`.execute(this.options.db);
    }
  }

  // ------------------------------------------------------------------ ferramenta de DLQ

  /**
   * Reprocessa uma mensagem da DLQ (RN-MSG-B-036). `corrected` substitui o envelope gravado
   * (correção manual). Se der certo, marca como REPROCESSED e libera a chave que ela bloqueava.
   */
  async reprocessDeadLetter(
    id: string,
    operator: string,
    note: string,
    corrected?: Envelope,
  ): Promise<void> {
    const row = await this.deadLetterRow(id);
    const envelope = corrected ?? (row.payload as Envelope);
    if (!envelope || typeof envelope !== 'object' || !('eventId' in envelope)) {
      throw new InvalidMessageError('a mensagem gravada não tem envelope válido: envie a correção');
    }
    const handler = this.handlerFor(envelope);
    if (!handler)
      throw new InvalidMessageError(
        `consumidor não trata ${envelope.eventType} v${envelope.eventVersion}`,
      );
    const resolve = async (trx: Kysely<unknown>) => {
      await sql`
        UPDATE dead_letter SET status = 'REPROCESSED', resolved_at = now(), resolved_by = ${operator}, resolution_note = ${note}
        WHERE id = ${id}`.execute(trx);
    };
    try {
      await this.options.db.transaction().execute((trx) =>
        this.applyOnce(trx, envelope, handler, {
          checkBlocked: false,
          takeOverBlock: false,
          stage: 0,
          afterApply: resolve,
        }),
      );
    } catch (err) {
      await sql`UPDATE dead_letter SET attempts = attempts + 1, error = ${errorText(err)} WHERE id = ${id}`.execute(
        this.options.db,
      );
      throw err;
    }
    if (this.options.ordered && row.partition_key) {
      await this.releaseKey(row.partition_key, (b) => b.dead_letter_id === id);
    }
  }

  /** Descarta uma mensagem da DLQ com justificativa e libera a chave que ela bloqueava. */
  async discardDeadLetter(
    id: string,
    operator: string,
    justification: string,
    audit?: (
      trx: Kysely<unknown>,
      deadLetter: { id: string; partitionKey: string | null },
    ) => Promise<void>,
  ): Promise<void> {
    if (!justification.trim())
      throw new InvalidMessageError('justificativa obrigatória para descartar (RN-MSG-B-036)');
    const row = await this.deadLetterRow(id);
    await this.options.db.transaction().execute(async (trx) => {
      await sql`
        UPDATE dead_letter SET status = 'DISCARDED', resolved_at = now(), resolved_by = ${operator}, resolution_note = ${justification}
        WHERE id = ${id}`.execute(trx);
      await audit?.(trx, { id, partitionKey: row.partition_key });
    });
    if (this.options.ordered && row.partition_key) {
      await this.releaseKey(row.partition_key, (b) => b.dead_letter_id === id);
    }
  }

  private async deadLetterRow(id: string): Promise<DeadLetterRow> {
    const row = (
      await sql<DeadLetterRow>`
        SELECT id, partition_key, payload, status, attempts FROM dead_letter
        WHERE id = ${id} AND consumer = ${this.options.name}`.execute(this.options.db)
    ).rows[0];
    if (!row)
      throw new InvalidMessageError(
        `mensagem não encontrada na DLQ de ${this.options.name}: ${id}`,
      );
    if (row.status !== 'PENDING')
      throw new InvalidMessageError(`mensagem já resolvida (${row.status}): ${id}`);
    return row;
  }
}
