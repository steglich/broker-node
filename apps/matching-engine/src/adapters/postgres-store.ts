import { EngineBookRecoveredV1 } from '@broker/contracts/events/engine.book_recovered/v1';
import { EngineBookRecoveringV1 } from '@broker/contracts/events/engine.book_recovering/v1';
import { EngineSnapshotTakenV1 } from '@broker/contracts/events/engine.snapshot_taken/v1';
import type { EventPublisher } from '@broker/messaging';
import { sql, type Kysely } from 'kysely';
import type {
  AppendBatch,
  EngineStore,
  JournalEntry,
  OutputRow,
  OutputSummary,
  StoredSnapshot,
} from '../application/ports.js';
import type { EngineSnapshot } from '../domain/engine.js';

const ACTOR = { type: 'SYSTEM' as const, id: 'matching-engine' };
/** Snapshots guardados por instrumento: o último e dois de reserva. */
const SNAPSHOTS_KEPT = 3;

interface JournalRow {
  instrument_id: string;
  input_seq: string;
  command_id: string | null;
  command: JournalEntry['input']['command'];
  ts: Date;
  trading_date: string;
  seed: string;
  correlation_id: string;
}

export class PostgresEngineStore implements EngineStore {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly publisher: EventPublisher,
  ) {}

  async instruments(partition: number): Promise<string[]> {
    const { rows } = await sql<{ instrument_id: string }>`
      SELECT instrument_id FROM engine_instrument WHERE partition = ${partition}
      ORDER BY instrument_id`.execute(this.db);
    return rows.map((r) => r.instrument_id);
  }

  async allInstruments(): Promise<{ instrumentId: string; partition: number }[]> {
    const { rows } = await sql<{ instrument_id: string; partition: number }>`
      SELECT instrument_id, partition FROM engine_instrument ORDER BY instrument_id`.execute(
      this.db,
    );
    return rows.map((r) => ({ instrumentId: r.instrument_id, partition: r.partition }));
  }

  async latestSnapshot(instrumentId: string): Promise<StoredSnapshot | null> {
    const { rows } = await sql<{ input_seq: string; state: EngineSnapshot }>`
      SELECT input_seq, state FROM engine_snapshot WHERE instrument_id = ${instrumentId}
      ORDER BY input_seq DESC LIMIT 1`.execute(this.db);
    const row = rows[0];
    return row ? { inputSeq: Number(row.input_seq), state: row.state } : null;
  }

  async journalAfter(
    instrumentId: string,
    afterSeq: number,
    limit: number,
  ): Promise<JournalEntry[]> {
    const { rows } = await sql<JournalRow>`
      SELECT instrument_id, input_seq, command_id, command, ts, trading_date::text AS trading_date,
             seed, correlation_id
      FROM engine_journal
      WHERE instrument_id = ${instrumentId} AND input_seq > ${afterSeq}
      ORDER BY input_seq LIMIT ${limit}`.execute(this.db);
    return rows.map((r) => ({
      instrumentId: r.instrument_id,
      commandId: r.command_id,
      correlationId: r.correlation_id,
      input: {
        inputSeq: Number(r.input_seq),
        ts: new Date(r.ts).getTime(),
        tradingDate: r.trading_date,
        seed: Number(r.seed),
        command: r.command,
      },
    }));
  }

  async knownCommands(
    instrumentIds: readonly string[],
    commandIds: readonly string[],
  ): Promise<string[]> {
    const { rows } = await sql<{ command_id: string }>`
      SELECT command_id FROM engine_journal
      WHERE instrument_id = ANY(${[...instrumentIds]}::text[])
        AND command_id = ANY(${[...commandIds]}::uuid[])`.execute(this.db);
    return rows.map((r) => r.command_id);
  }

  async append(batch: AppendBatch): Promise<void> {
    const { entries, position, dead } = batch;
    if (entries.length === 0 && !position && !dead?.length) return;
    await this.db.transaction().execute(async (trx) => {
      // O padrão do banco já é `on`; aqui fica explícito que esse commit não pode ser relaxado (D12).
      await sql`SET LOCAL synchronous_commit = on`.execute(trx);
      if (entries.length > 0) {
        const journal = entries.map((e) => ({
          instrument_id: e.instrumentId,
          input_seq: e.input.inputSeq,
          command_id: e.commandId,
          command: e.input.command,
          ts: new Date(e.input.ts).toISOString(),
          trading_date: e.input.tradingDate,
          seed: e.input.seed,
          correlation_id: e.correlationId,
        }));
        await sql`
          INSERT INTO engine_journal
            (instrument_id, input_seq, command_id, command, ts, trading_date, seed, correlation_id)
          SELECT instrument_id, input_seq, command_id, command, ts, trading_date, seed, correlation_id
          FROM jsonb_to_recordset(${JSON.stringify(journal)}::jsonb) AS x(
            instrument_id text, input_seq bigint, command_id uuid, command jsonb, ts timestamptz,
            trading_date date, seed bigint, correlation_id text)`.execute(trx);
        const ids = [...new Set(entries.map((e) => e.instrumentId))];
        await sql`
          INSERT INTO engine_instrument (instrument_id, partition)
          SELECT id, ${batch.partition}::integer FROM unnest(${ids}::text[]) AS id
          ON CONFLICT (instrument_id) DO NOTHING`.execute(trx);
      }
      for (const d of dead ?? []) {
        await sql`
          INSERT INTO dead_letter (id, consumer, stream, partition, "offset", payload, error, attempts)
          VALUES (${d.id}, ${position?.consumer ?? 'engine.sequencer'}, ${position?.stream ?? ''},
                  ${batch.partition}, ${d.offset}, ${JSON.stringify({ raw: d.raw })}::jsonb, ${d.error}, 1)`.execute(
          trx,
        );
      }
      if (position) {
        await sql`
          INSERT INTO consumer_offset (consumer, stream, partition, "offset")
          VALUES (${position.consumer}, ${position.stream}, ${batch.partition}, ${position.offset})
          ON CONFLICT (consumer, stream, partition)
          DO UPDATE SET "offset" = EXCLUDED."offset", updated_at = now()`.execute(trx);
      }
    });
  }

  async writeOutputs(rows: readonly OutputRow[]): Promise<void> {
    if (rows.length === 0) return;
    const values = rows.map((r) => ({
      instrument_id: r.instrumentId,
      board: r.board,
      engine_seq: r.engineSeq,
      input_seq: r.inputSeq,
      event_id: r.eventId,
      event_type: r.eventType,
      payload: r.payload,
      occurred_at: new Date(r.occurredAt).toISOString(),
      causation_id: r.causationId,
      correlation_id: r.correlationId,
    }));
    // `seq` precisa sair na ordem em que as saídas foram geradas.
    await sql`
      INSERT INTO engine_output
        (instrument_id, board, engine_seq, input_seq, event_id, event_type, payload, occurred_at,
         causation_id, correlation_id)
      SELECT instrument_id, board, engine_seq, input_seq, event_id, event_type, payload, occurred_at,
             causation_id, correlation_id
      FROM ROWS FROM (jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS (
        instrument_id text, board text, engine_seq bigint, input_seq bigint, event_id uuid,
        event_type text, payload jsonb, occurred_at timestamptz, causation_id uuid,
        correlation_id text)) WITH ORDINALITY AS x
      ORDER BY x.ordinality
      ON CONFLICT (instrument_id, board, engine_seq) DO NOTHING`.execute(this.db);
  }

  async saveSnapshot(
    instrumentId: string,
    snapshot: EngineSnapshot,
    takenAt: number,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`
        INSERT INTO engine_snapshot (instrument_id, input_seq, state, taken_at)
        VALUES (${instrumentId}, ${snapshot.inputSeq}, ${JSON.stringify(snapshot)}::jsonb,
                ${new Date(takenAt).toISOString()})
        ON CONFLICT (instrument_id, input_seq) DO NOTHING`.execute(trx);
      await sql`
        DELETE FROM engine_snapshot
        WHERE instrument_id = ${instrumentId} AND input_seq NOT IN (
          SELECT input_seq FROM engine_snapshot WHERE instrument_id = ${instrumentId}
          ORDER BY input_seq DESC LIMIT ${SNAPSHOTS_KEPT})`.execute(trx);
      await this.publisher.publish(
        trx,
        EngineSnapshotTakenV1,
        { instrumentId, inputSeq: snapshot.inputSeq },
        this.context(instrumentId),
      );
    });
  }

  async savedOffset(
    consumer: string,
    stream: string,
    partition: number,
  ): Promise<bigint | undefined> {
    const { rows } = await sql<{ offset: string }>`
      SELECT "offset" FROM consumer_offset
      WHERE consumer = ${consumer} AND stream = ${stream} AND partition = ${partition}`.execute(
      this.db,
    );
    return rows[0] ? BigInt(rows[0].offset) : undefined;
  }

  async publishRecovery(instrumentId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const context = this.context(instrumentId);
      await this.publisher.publish(trx, EngineBookRecoveringV1, { instrumentId }, context);
      await this.publisher.publish(trx, EngineBookRecoveredV1, { instrumentId }, context);
    });
  }

  async outputsOf(instrumentId: string): Promise<OutputSummary> {
    const { rows } = await sql<{
      board: OutputRow['board'];
      engine_seq: string;
      event_type: string;
      payload: Record<string, unknown>;
    }>`
      SELECT board, engine_seq, event_type, payload FROM engine_output
      WHERE instrument_id = ${instrumentId} ORDER BY board, engine_seq`.execute(this.db);
    return {
      count: rows.length,
      rows: rows.map((r) => ({
        board: r.board,
        engineSeq: Number(r.engine_seq),
        eventType: r.event_type,
        payload: r.payload,
      })),
    };
  }

  private context(instrumentId: string) {
    return {
      partitionKey: instrumentId,
      aggregateType: 'engine',
      aggregateId: instrumentId,
      actor: ACTOR,
    };
  }
}
