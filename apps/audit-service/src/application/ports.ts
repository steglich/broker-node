import type { AuditEntry, AuditRecord, ChainBreak } from '../domain/record.js';

export interface RecordFilter {
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  /** Período em `occurred_at`, ISO UTC; `to` exclusivo. */
  from: string;
  to: string;
  /** Página: registros com `seq` menor que este (mais novos primeiro). */
  beforeSeq?: number;
  limit: number;
}

export interface AnchorRow {
  businessDate: string;
  seq: number;
  hash: string;
  objectKey: string;
  versionId: string | null;
  anchoredAt: string;
}

export interface VerificationRow {
  id: string;
  businessDate: string | null;
  status: 'OK' | 'BROKEN';
  verifiedThroughSeq: number;
  broken: ChainBreak | null;
  reason: string | null;
  startedAt: string;
  finishedAt: string;
}

/** Eventos que a trilha publica (via outbox): a resposta à rotina diária do agendador. */
export type AuditEvent =
  | {
      type: 'routine.completed';
      payload: {
        routineName: string;
        businessDate: string;
        executionId: string;
        stats?: Record<string, unknown>;
      };
    }
  | {
      type: 'routine.failed';
      payload: { routineName: string; businessDate: string; executionId: string; reason: string };
    };

/** Unidade de trabalho: uma transação do banco da auditoria. */
export interface AuditTx {
  /**
   * Trava a cabeça da cadeia até o fim da transação e devolve o último registro. Serializa os
   * appends: dois consumidores nunca encadeiam no mesmo `prev_hash`.
   */
  lockHead(): Promise<{ seq: number; hash: string } | null>;
  /** `false` se o evento já estava na trilha (`event_id` único). */
  hasEvent(eventId: string): Promise<boolean>;
  insert(record: AuditRecord): Promise<void>;
  anchorOf(businessDate: string): Promise<AnchorRow | null>;
  insertAnchor(anchor: AnchorRow): Promise<void>;
  insertVerification(v: VerificationRow): Promise<void>;
  publish(event: AuditEvent): Promise<void>;
}

export interface AuditStore {
  transaction<T>(fn: (tx: AuditTx) => Promise<T>): Promise<T>;
  /** Registros em ordem de `seq`, a partir de `fromSeq`, em lotes (verificação da cadeia). */
  recordsFrom(fromSeq: number, limit: number): Promise<AuditRecord[]>;
  recordAt(seq: number): Promise<AuditRecord | null>;
  find(filter: RecordFilter): Promise<AuditRecord[]>;
  lastAnchor(): Promise<AnchorRow | null>;
  verifications(limit: number): Promise<VerificationRow[]>;
}

export class AnchorConflictError extends Error {}

/**
 * Storage das âncoras diárias, separado do banco e com retenção imutável (RN-AUD-002): o bucket
 * `audit-anchors` do MinIO com object lock em modo COMPLIANCE.
 */
export interface AnchorStorage {
  /**
   * Grava o objeto só se a chave ainda não existir. Se já existir com o mesmo conteúdo, devolve a
   * versão gravada (re-execução da rotina); com conteúdo diferente, lança `AnchorConflictError`.
   */
  putOnce(key: string, body: string): Promise<{ versionId: string | null }>;
  get(key: string): Promise<string | null>;
}

/** Alerta crítico (RN-AUD-001): a cadeia quebrou ou a âncora não confere. */
export interface CriticalAuditAlert {
  kind: 'CHAIN_BROKEN' | 'ANCHOR_MISMATCH';
  businessDate: string;
  detail: string;
}

export type { AuditEntry };
