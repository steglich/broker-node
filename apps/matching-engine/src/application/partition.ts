import type { Clock } from '@broker/clock';
import { parseEnvelope, type Envelope } from '@broker/messaging';
import { deterministicId, hash32, IdKind } from '../domain/deterministic.js';
import { InstrumentEngine } from '../domain/engine.js';
import type { EngineCommand, EngineOutput } from '../domain/inputs.js';
import { decodeCommand, type DecodedCommand } from './commands.js';
import type { DeadCommand, EngineStore, JournalEntry, OutputRow } from './ports.js';

export const SEQUENCER_CONSUMER = 'engine.sequencer';

export interface PartitionOptions {
  partition: number;
  stream: string;
  environment: string;
  store: EngineStore;
  clock: Clock;
  newId: () => string;
  newSeed: () => number;
  /** Tamanho máximo do micro-lote do *group commit* (D12). */
  maxBatch?: number;
  /** RN-REC-001. */
  snapshotEveryInputs?: number;
  onOutputs?: () => void;
  onFatal: (err: unknown) => void;
  onInvalid?: (error: string) => void;
  /** Gancho de teste: roda depois do journal durável e antes do processamento. */
  afterJournal?: (entries: readonly JournalEntry[]) => void | Promise<void>;
}

interface BusMessage {
  raw: Buffer;
  offset: bigint;
}

interface Internal {
  instrumentId: string;
  command: EngineCommand;
}

const REPLAY_PAGE = 5000;

/** Converte a saída do domínio em linha: o `eventId` é fixo, então um replay gera o mesmo evento. */
export function outputRow(
  instrumentId: string,
  output: EngineOutput,
  commandId: string | null,
  correlationId: string,
): OutputRow {
  return {
    instrumentId,
    board: output.board,
    engineSeq: output.engineSeq,
    inputSeq: output.inputSeq,
    eventId: deterministicId(
      output.ts,
      hash32(instrumentId),
      output.board,
      output.engineSeq,
      IdKind.EVENT,
    ),
    eventType: output.eventType,
    payload: output.payload,
    occurredAt: output.ts,
    causationId: commandId,
    correlationId,
  };
}

/**
 * Sequenciador de uma partição de `engine.commands` (D12, RN-ME-001/003/004). Um único laço, então
 * os livros da partição nunca são tocados em paralelo:
 *
 *   1. junta o que chegou num micro-lote e carimba `input_seq`, tempo e semente;
 *   2. grava o lote no journal, com o offset, numa transação síncrona (*group commit*);
 *   3. processa em memória e 4. grava as saídas em `engine_output`.
 *
 * Cair entre 2 e 4 não perde nada: a recuperação reprocessa o journal e regera as mesmas saídas.
 */
export class EnginePartition {
  private readonly engines = new Map<string, InstrumentEngine>();
  private readonly sinceSnapshot = new Map<string, number>();
  private readonly bus: BusMessage[] = [];
  private readonly internal: Internal[] = [];
  private readonly ticking = new Set<string>();
  /** Snapshots pedidos de fora: rodam entre dois lotes, com as saídas já gravadas. */
  private readonly jobs: (() => Promise<void>)[] = [];
  private draining: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly o: PartitionOptions) {}

  get instrumentIds(): string[] {
    return [...this.engines.keys()];
  }

  engine(instrumentId: string): InstrumentEngine | undefined {
    return this.engines.get(instrumentId);
  }

  // ------------------------------------------------------------------- recuperação (RN-REC-002)

  /**
   * Volta ao último estado: snapshot + journal, regravando as saídas. Roda antes de o leitor da
   * partição começar, então nenhum comando novo passa na frente. Quem estava com o livro ao vivo
   * fica suspenso até a sessão retomar por leilão (RN-REC-003): a suspensão entra no journal, para o
   * próximo replay passar pelo mesmo caminho.
   */
  async recover(): Promise<{ instruments: number; replayed: number }> {
    let replayed = 0;
    const ids = await this.o.store.instruments(this.o.partition);
    for (const id of ids) {
      const snapshot = await this.o.store.latestSnapshot(id);
      const engine = snapshot ? InstrumentEngine.restore(snapshot.state) : new InstrumentEngine(id);
      this.engines.set(id, engine);
      for (;;) {
        const page = await this.o.store.journalAfter(id, engine.inputSeq, REPLAY_PAGE);
        if (page.length === 0) break;
        const rows: OutputRow[] = [];
        for (const entry of page)
          for (const output of engine.process(entry.input))
            rows.push(outputRow(id, output, entry.commandId, entry.correlationId));
        await this.o.store.writeOutputs(rows);
        replayed += page.length;
      }
      if (engine.phase === 'CLOSED' || engine.phase === 'PRE_TRADING') continue;
      if (engine.phase === 'POST_CLOSE' || engine.phase === 'AFTER_MARKET') continue;
      await this.appendAndProcess([
        this.stamp(id, { kind: 'RecoveryHalt' }, null, `recovery:${id}`, new Map()),
      ]);
      await this.o.store.publishRecovery(id);
    }
    this.o.onOutputs?.();
    return { instruments: ids.length, replayed };
  }

  // ------------------------------------------------------------------- entrada

  enqueue(raw: Buffer, offset: bigint): void {
    if (this.stopped) return;
    this.bus.push({ raw, offset });
    this.wake();
  }

  /** Um `Tick` para cada leilão que o tempo já encerrou (RN-AUC-033). */
  tick(): void {
    if (this.stopped) return;
    const now = this.o.clock.now().epochMillis;
    for (const [id, engine] of this.engines) {
      const deadline = engine.nextDeadline();
      if (deadline === null || deadline > now || this.ticking.has(id)) continue;
      this.ticking.add(id);
      this.internal.push({ instrumentId: id, command: { kind: 'Tick' } });
    }
    if (this.internal.length > 0) this.wake();
  }

  /** Espera o que já foi aceito ser processado e para de aceitar. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.draining;
  }

  /** Resolve quando a fila zerar (testes e encerramento). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private wake(): void {
    if (this.draining) return;
    this.draining = this.drain()
      .catch((err: unknown) => {
        this.stopped = true;
        this.o.onFatal(err);
      })
      .finally(() => {
        this.draining = undefined;
      });
  }

  private async drain(): Promise<void> {
    const max = this.o.maxBatch ?? 500;
    while (!this.stopped) {
      for (const job of this.jobs.splice(0)) await job();
      if (this.bus.length === 0 && this.internal.length === 0) return;
      const internal = this.internal.splice(0, max);
      const messages = this.bus.splice(0, max - internal.length);
      await this.processBatch(internal, messages);
    }
  }

  // ------------------------------------------------------------------- lote

  private stamp(
    instrumentId: string,
    command: EngineCommand,
    commandId: string | null,
    correlationId: string,
    pending: Map<string, number>,
  ): JournalEntry {
    const last = pending.get(instrumentId) ?? this.engines.get(instrumentId)?.inputSeq ?? 0;
    pending.set(instrumentId, last + 1);
    const now = this.o.clock.now();
    return {
      instrumentId,
      commandId,
      correlationId,
      input: {
        inputSeq: last + 1,
        ts: now.epochMillis,
        tradingDate: now.businessDate().toString(),
        seed: this.o.newSeed(),
        command,
      },
    };
  }

  private async processBatch(internal: Internal[], messages: BusMessage[]): Promise<void> {
    const decoded: { envelope: Envelope; command: DecodedCommand }[] = [];
    const dead: DeadCommand[] = [];
    for (const m of messages) {
      try {
        const envelope = parseEnvelope(m.raw, this.o.environment);
        const command = decodeCommand(envelope);
        if (command) decoded.push({ envelope, command });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        dead.push({ id: this.o.newId(), offset: m.offset, raw: m.raw.toString('utf8'), error });
        this.o.onInvalid?.(error);
      }
    }

    // O broker pode reentregar um comando com offset novo (o relay do produtor repetiu o envio).
    const known = new Set(
      decoded.length === 0
        ? []
        : await this.o.store.knownCommands(
            [...new Set(decoded.map((d) => d.command.instrumentId))],
            decoded.map((d) => d.envelope.eventId),
          ),
    );
    const pending = new Map<string, number>();
    const entries: JournalEntry[] = internal.map((i) =>
      this.stamp(i.instrumentId, i.command, null, `tick:${i.instrumentId}`, pending),
    );
    for (const { envelope, command } of decoded) {
      if (known.has(envelope.eventId)) continue;
      known.add(envelope.eventId);
      entries.push(
        this.stamp(
          command.instrumentId,
          command.command,
          envelope.eventId,
          envelope.correlationId,
          pending,
        ),
      );
    }

    const last = messages[messages.length - 1];
    await this.o.store.append({
      partition: this.o.partition,
      entries,
      dead,
      ...(last
        ? { position: { consumer: SEQUENCER_CONSUMER, stream: this.o.stream, offset: last.offset } }
        : {}),
    });
    await this.o.afterJournal?.(entries);
    await this.processEntries(entries);
    for (const i of internal) this.ticking.delete(i.instrumentId);
  }

  private async appendAndProcess(entries: JournalEntry[]): Promise<void> {
    await this.o.store.append({ partition: this.o.partition, entries });
    await this.processEntries(entries);
  }

  private async processEntries(entries: readonly JournalEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const rows: OutputRow[] = [];
    for (const entry of entries) {
      const id = entry.instrumentId;
      let engine = this.engines.get(id);
      if (!engine) {
        engine = new InstrumentEngine(id);
        this.engines.set(id, engine);
      }
      for (const output of engine.process(entry.input))
        rows.push(outputRow(id, output, entry.commandId, entry.correlationId));
      this.sinceSnapshot.set(id, (this.sinceSnapshot.get(id) ?? 0) + 1);
    }
    await this.o.store.writeOutputs(rows);
    this.o.onOutputs?.();

    const every = this.o.snapshotEveryInputs ?? 10_000;
    for (const [id, count] of this.sinceSnapshot) if (count >= every) await this.snapshot(id);
  }

  // ------------------------------------------------------------------- snapshots (RN-REC-001)

  /**
   * Só depois de as saídas estarem gravadas: o replay parte do snapshot e não regeneraria o que
   * ficou para trás dele. Por isso roda no próprio laço.
   */
  private async snapshot(instrumentId: string): Promise<number | null> {
    const engine = this.engines.get(instrumentId);
    if (!engine) return null;
    await this.o.store.saveSnapshot(
      instrumentId,
      engine.snapshot(),
      this.o.clock.now().epochMillis,
    );
    this.sinceSnapshot.set(instrumentId, 0);
    return engine.inputSeq;
  }

  private inLoop<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.jobs.push(() => job().then(resolve, reject));
      this.wake();
    });
  }

  /** Pedido da API administrativa. Devolve o `input_seq` do snapshot, ou `null` sem esse livro. */
  requestSnapshot(instrumentId: string): Promise<number | null> {
    return this.inLoop(() => this.snapshot(instrumentId));
  }

  /** Vencimento dos 5 minutos: só de quem recebeu entradas desde o último snapshot. */
  snapshotDue(): Promise<void> {
    return this.inLoop(async () => {
      for (const [id, count] of this.sinceSnapshot) if (count > 0) await this.snapshot(id);
    });
  }
}
