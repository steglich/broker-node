import { createHash } from 'node:crypto';

/** `prev_hash` do primeiro registro da cadeia. */
export const GENESIS_HASH = '0'.repeat(64);

/** Conteúdo de um registro de auditoria (RN-AUD-BO-001), sem `seq` e sem os hashes. */
export interface AuditEntry {
  /** Evento de origem (deduplicação) ou id gerado para o registro escrito pelo próprio serviço. */
  eventId: string;
  actorType: string;
  actorId: string;
  actorRoles: string[];
  action: string;
  resourceType: string;
  resourceId: string | null;
  /** Já mascarados (RN-AUD-003). */
  before: unknown;
  after: unknown;
  /** Caminhos que mudaram entre `before` e `after`, calculados antes do mascaramento. */
  changedFields: string[];
  justification: string | null;
  approvalRequestId: string | null;
  ip: string | null;
  userAgent: string | null;
  source: string;
  /** ISO 8601 UTC com milissegundos. */
  occurredAt: string;
  recordedAt: string;
  correlationId: string;
}

export interface AuditRecord extends AuditEntry {
  seq: number;
  prevHash: string;
  hash: string;
}

/** JSON com as chaves ordenadas em todos os níveis: a mesma entrada dá sempre os mesmos bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

const ENTRY_FIELDS = [
  'eventId',
  'actorType',
  'actorId',
  'actorRoles',
  'action',
  'resourceType',
  'resourceId',
  'before',
  'after',
  'changedFields',
  'justification',
  'approvalRequestId',
  'ip',
  'userAgent',
  'source',
  'occurredAt',
  'recordedAt',
  'correlationId',
] as const satisfies readonly (keyof AuditEntry)[];

/**
 * Conteúdo canônico de um registro: os campos de `AuditEntry` (e só eles, mesmo que o objeto traga
 * `prevHash`/`hash`) mais o `seq` (RN-AUD-001).
 */
export function canonicalContent(seq: number, entry: AuditEntry): string {
  const content: Record<string, unknown> = { seq };
  for (const f of ENTRY_FIELDS) content[f] = entry[f];
  return canonicalJson(content);
}

/** `hash = H(prev_hash || conteúdo canônico)`, SHA-256 em hexadecimal (RN-AUD-001). */
export const chainHash = (prevHash: string, seq: number, entry: AuditEntry): string =>
  createHash('sha256').update(prevHash).update(canonicalContent(seq, entry)).digest('hex');

/** Encadeia uma entrada depois de `previous` (ou no início da cadeia). */
export function chain(
  previous: { seq: number; hash: string } | null,
  entry: AuditEntry,
): AuditRecord {
  const seq = (previous?.seq ?? 0) + 1;
  const prevHash = previous?.hash ?? GENESIS_HASH;
  return { ...entry, seq, prevHash, hash: chainHash(prevHash, seq, entry) };
}

export type ChainBreak =
  | { kind: 'SEQ_GAP'; seq: number; expected: number }
  | { kind: 'PREV_HASH_MISMATCH'; seq: number }
  | { kind: 'HASH_MISMATCH'; seq: number };

/**
 * Verificador incremental da cadeia: recebe os registros em ordem de `seq`, em lotes, e para no
 * primeiro elo quebrado. `seq` contínuo, `prev_hash` igual ao hash anterior e hash recalculado.
 */
export class ChainVerifier {
  private last: { seq: number; hash: string } | null = null;
  private broken: ChainBreak | null = null;

  /** `false` quando achou a quebra (os registros seguintes não importam). */
  feed(records: readonly AuditRecord[]): boolean {
    for (const r of records) {
      if (this.broken) return false;
      const expected = (this.last?.seq ?? 0) + 1;
      if (r.seq !== expected) this.broken = { kind: 'SEQ_GAP', seq: r.seq, expected };
      else if (r.prevHash !== (this.last?.hash ?? GENESIS_HASH))
        this.broken = { kind: 'PREV_HASH_MISMATCH', seq: r.seq };
      else if (r.hash !== chainHash(r.prevHash, r.seq, r))
        this.broken = { kind: 'HASH_MISMATCH', seq: r.seq };
      else this.last = { seq: r.seq, hash: r.hash };
    }
    return !this.broken;
  }

  result():
    | { ok: true; head: { seq: number; hash: string } | null }
    | { ok: false; head: { seq: number; hash: string } | null; break: ChainBreak } {
    return this.broken
      ? { ok: false, head: this.last, break: this.broken }
      : { ok: true, head: this.last };
  }
}
