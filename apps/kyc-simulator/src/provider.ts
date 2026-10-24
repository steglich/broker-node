import type { Clock } from '@broker/clock';
import { inTransaction } from '@broker/persistence';
import { businessRule, notFound } from '@broker/service-kit';
import type { Latency, SimulatorControl } from '@broker/simulator-kit';
import type { WebhookDispatcher } from '@broker/webhooks';
import { sql, type Kysely } from 'kysely';
import { fetchAndInspect, isSignedUrl } from './documents.js';
import { decide, KYC_SCENARIOS, type KycScenario, type Verification } from './rules.js';

export interface KycProviderOptions {
  db: Kysely<unknown>;
  clock: Clock;
  dispatcher: WebhookDispatcher;
  control: SimulatorControl<KycScenario>;
  newId: () => string;
  webhookUrl: string;
  /** Tempo até o resultado (RN-ONB-021: padrão 2 a 10 s). */
  resultDelay: Latency;
  random: () => number;
}

interface CheckRow {
  id: string;
  reference_id: string;
  tax_id: string;
  full_name: string;
  birth_date: string;
  document_types: string[];
  document_refs: Array<{ type: string; url: string }> | null;
  forced: KycScenario | null;
  status: 'PROCESSING' | 'COMPLETED';
  process_at: Date;
  verifications: Verification[];
  created_at: Date;
  completed_at: Date | null;
}

export interface SubmitInput {
  reference_id: string;
  tax_id: string;
  full_name: string;
  birth_date: string;
  documents: Array<{ type: string; url: string }>;
}

/**
 * Provedor de KYC: aceita a submissão na hora (`202`) e responde depois, por webhook, como um
 * fornecedor real. `runDue` processa as verificações cujo prazo simulado já venceu.
 */
export class KycProvider {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<number> | undefined;

  constructor(private readonly o: KycProviderOptions) {}

  async submit(input: SubmitInput): Promise<{ check_id: string; status: 'PROCESSING' }> {
    const unsigned = input.documents.find((d) => !isSignedUrl(d.url));
    if (unsigned) {
      throw businessRule(
        'DOCUMENT_URL_NOT_SIGNED',
        `A referência de ${unsigned.type} precisa ser uma URL pré-assinada e temporária (RN-KYCS-001).`,
      );
    }
    const forced = KYC_SCENARIOS.map((s) => s.id).find((s) => this.o.control.consume(s)) ?? null;
    const id = this.o.newId();
    const now = this.o.clock.now();
    const d = this.o.resultDelay;
    const delay =
      d.kind === 'fixed' ? d.ms : d.minMs + Math.floor(this.o.random() * (d.maxMs - d.minMs + 1));
    await sql`
      INSERT INTO kyc_check (id, reference_id, tax_id, full_name, birth_date, document_types, document_refs,
                             forced, status, process_at, created_at)
      VALUES (${id}, ${input.reference_id}, ${input.tax_id}, ${input.full_name}, ${input.birth_date},
              ${input.documents.map((x) => x.type)}, ${JSON.stringify(input.documents)}, ${forced},
              'PROCESSING', ${now.plusMillis(delay).toString()}, ${now.toString()})`.execute(
      this.o.db,
    );
    return { check_id: id, status: 'PROCESSING' };
  }

  async get(id: string) {
    const row = (await sql<CheckRow>`SELECT * FROM kyc_check WHERE id = ${id}`.execute(this.o.db))
      .rows[0];
    if (!row) throw notFound('Verificação inexistente.');
    return view(row);
  }

  async list(limit = 50) {
    const { rows } =
      await sql<CheckRow>`SELECT * FROM kyc_check ORDER BY created_at DESC, id DESC LIMIT ${limit}`.execute(
        this.o.db,
      );
    return rows.map(view);
  }

  /** Processa as verificações vencidas; devolve quantas concluiu. */
  async runDue(limit = 20): Promise<number> {
    let done = 0;
    while (done < limit && (await this.processNext())) done++;
    return done;
  }

  start(intervalMs = 500): void {
    const tick = () => {
      this.running = this.runDue().catch(() => 0);
      void this.running.finally(() => {
        if (this.timer !== undefined) this.timer = setTimeout(tick, intervalMs);
      });
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private async processNext(): Promise<boolean> {
    return inTransaction(this.o.db, async (trx) => {
      const now = this.o.clock.now();
      const row = (
        await sql<CheckRow>`
          SELECT * FROM kyc_check WHERE status = 'PROCESSING' AND process_at <= ${now.toString()}
          ORDER BY process_at LIMIT 1 FOR UPDATE SKIP LOCKED`.execute(trx)
      ).rows[0];
      if (!row) return false;

      const documents = await Promise.all(
        (row.document_refs ?? []).map(async (d) => ({
          type: d.type,
          result: await fetchAndInspect(d.url),
        })),
      );
      const verifications = decide({
        taxId: row.tax_id,
        documents,
        forced: row.forced,
        random: this.o.random,
      });
      // As referências saem do banco junto com a conclusão: nada do documento fica (RN-KYCS-001).
      await sql`
        UPDATE kyc_check SET status = 'COMPLETED', verifications = ${JSON.stringify(verifications)},
               document_refs = NULL, completed_at = ${now.toString()}
        WHERE id = ${row.id}`.execute(trx);

      const base = { check_id: row.id, reference_id: row.reference_id };
      for (const verification of verifications) {
        await this.o.dispatcher.enqueue(trx, {
          eventId: `${row.id}:${verification.type}`,
          eventType: 'check.verification_completed',
          url: this.o.webhookUrl,
          body: { ...base, verification },
        });
      }
      await this.o.dispatcher.enqueue(trx, {
        eventId: `${row.id}:completed`,
        eventType: 'check.completed',
        url: this.o.webhookUrl,
        body: { ...base, verifications },
      });
      return true;
    });
  }
}

function view(row: CheckRow) {
  return {
    check_id: row.id,
    reference_id: row.reference_id,
    status: row.status,
    verifications: row.verifications,
    created_at: row.created_at.toISOString(),
    completed_at: row.completed_at?.toISOString() ?? null,
  };
}
