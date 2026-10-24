import type { Clock } from '@broker/clock';
import { entryFromEvent, isAuditable, mask, type CapturedEvent } from '../domain/capture.js';
import {
  canonicalJson,
  chain,
  ChainVerifier,
  GENESIS_HASH,
  type AuditEntry,
  type AuditRecord,
  type ChainBreak,
} from '../domain/record.js';
import {
  AnchorConflictError,
  type AnchorStorage,
  type AuditStore,
  type AuditTx,
  type CriticalAuditAlert,
  type RecordFilter,
} from './ports.js';

/** Rotina diária do agendador que verifica a cadeia e grava a âncora (RN-AUD-001/002). */
export const DAILY_ROUTINE = 'audit_chain_verify';

const VERIFY_BATCH = 1000;

export type VerifyResult =
  | { ok: true; head: { seq: number; hash: string } | null }
  | {
      ok: false;
      head: { seq: number; hash: string } | null;
      break?: ChainBreak;
      alert: CriticalAuditAlert['kind'];
      reason: string;
    };

/** Quem fez a consulta à trilha (vem do contexto da requisição). */
export interface Requester {
  actor: { type: string; id: string };
  roles: readonly string[];
  ip?: string;
  userAgent?: string;
  correlationId: string;
}

export interface AuditTrailDeps {
  store: AuditStore;
  anchors: AnchorStorage;
  clock: Clock;
  newId: () => string;
  environment: string;
  serviceName: string;
  onCriticalAlert: (alert: CriticalAuditAlert) => void;
}

/** A anchor gravada no storage (o corpo do objeto). */
interface AnchorBody {
  environment: string;
  businessDate: string;
  seq: number;
  hash: string;
}

const describe = (b: ChainBreak) =>
  b.kind === 'SEQ_GAP'
    ? `seq ${b.seq} no lugar de ${b.expected}`
    : b.kind === 'PREV_HASH_MISMATCH'
      ? `prev_hash do seq ${b.seq} não é o hash do anterior`
      : `hash do seq ${b.seq} não confere com o conteúdo`;

/**
 * Trilha de auditoria (Segurança de aplicação §3, RN-AUD-001..005): captura append-only encadeada
 * por hash, verificação e ancoragem diárias e consulta auditada.
 */
export class AuditTrail {
  constructor(private readonly d: AuditTrailDeps) {}

  /**
   * Encadeia uma entrada no fim da trilha, na transação dada. Idempotente pelo `eventId`:
   * devolve `null` se o evento já estava gravado.
   */
  async append(tx: AuditTx, entry: AuditEntry): Promise<AuditRecord | null> {
    const head = await tx.lockHead();
    if (await tx.hasEvent(entry.eventId)) return null;
    const record = chain(head, entry);
    await tx.insert(record);
    return record;
  }

  /** Grava um evento do barramento se ele for auditável (RN-AUD-BO-001); senão ignora. */
  async capture(tx: AuditTx, event: CapturedEvent): Promise<AuditRecord | null> {
    if (!isAuditable(event)) return null;
    return this.append(tx, entryFromEvent(event, this.d.clock.now().toString()));
  }

  /**
   * Recalcula a cadeia inteira e confere a última âncora contra o storage imutável. Uma edição
   * direta no banco quebra o hash do registro; uma cadeia toda regravada não bate com a âncora.
   */
  async verify(): Promise<VerifyResult> {
    const verifier = new ChainVerifier();
    let next = 1;
    for (;;) {
      const batch = await this.d.store.recordsFrom(next, VERIFY_BATCH);
      if (batch.length === 0 || !verifier.feed(batch)) break;
      next = batch[batch.length - 1]!.seq + 1;
    }
    const result = verifier.result();
    if (!result.ok) {
      return {
        ok: false,
        head: result.head,
        break: result.break,
        alert: 'CHAIN_BROKEN',
        reason: `cadeia quebrada: ${describe(result.break)}`,
      };
    }
    const anchor = await this.d.store.lastAnchor();
    if (anchor && anchor.seq > 0) {
      const stored = await this.d.anchors.get(anchor.objectKey);
      const body = stored ? (JSON.parse(stored) as AnchorBody) : null;
      const record = await this.d.store.recordAt(anchor.seq);
      if (!body || body.seq !== anchor.seq || !record || record.hash !== body.hash) {
        return {
          ok: false,
          head: result.head,
          alert: 'ANCHOR_MISMATCH',
          reason: `a âncora de ${anchor.businessDate} (seq ${anchor.seq}) não confere com a trilha`,
        };
      }
    }
    return { ok: true, head: result.head };
  }

  /**
   * Rotina diária (RN-AUD-001/002): verifica a cadeia e grava o hash do último registro no storage
   * de âncoras. Quebra → alerta crítico e `routine.failed`. Idempotente por data de negócio.
   */
  async runDaily(trigger: {
    routineName: string;
    businessDate: string;
    executionId: string;
  }): Promise<'ANCHORED' | 'ALREADY_ANCHORED' | 'BROKEN'> {
    const { businessDate, executionId, routineName } = trigger;
    const already = await this.d.store.transaction(async (tx) => {
      const anchor = await tx.anchorOf(businessDate);
      if (anchor) {
        await tx.publish({
          type: 'routine.completed',
          payload: {
            routineName,
            businessDate,
            executionId,
            stats: { seq: anchor.seq, hash: anchor.hash },
          },
        });
      }
      return anchor !== null;
    });
    if (already) return 'ALREADY_ANCHORED';

    const startedAt = this.d.clock.now().toString();
    const verification = await this.verify();
    let head = verification.head ?? { seq: 0, hash: GENESIS_HASH };
    let failure = verification.ok ? null : verification;
    let versionId: string | null = null;
    const objectKey = `${this.d.environment}/${businessDate}.json`;

    if (!failure) {
      const body: AnchorBody = {
        environment: this.d.environment,
        businessDate,
        seq: head.seq,
        hash: head.hash,
      };
      try {
        ({ versionId } = await this.d.anchors.putOnce(objectKey, canonicalJson(body)));
      } catch (err) {
        if (!(err instanceof AnchorConflictError)) throw err;
        // Re-execução depois de gravar a âncora e cair antes do commit: vale a já gravada, se ela
        // for um elo verdadeiro da cadeia.
        const stored = await this.d.anchors.get(objectKey);
        const existing = stored ? (JSON.parse(stored) as AnchorBody) : null;
        const record = existing ? await this.d.store.recordAt(existing.seq) : null;
        if (existing && (existing.seq === 0 || record?.hash === existing.hash)) {
          head = { seq: existing.seq, hash: existing.hash };
        } else {
          failure = {
            ok: false,
            head,
            alert: 'ANCHOR_MISMATCH',
            reason: `já existe outra âncora para ${businessDate} e ela não confere com a trilha`,
          };
        }
      }
    }

    const finishedAt = this.d.clock.now().toString();
    await this.d.store.transaction(async (tx) => {
      await tx.insertVerification({
        id: this.d.newId(),
        businessDate,
        status: failure ? 'BROKEN' : 'OK',
        verifiedThroughSeq: verification.head?.seq ?? 0,
        broken: failure?.break ?? null,
        reason: failure?.reason ?? null,
        startedAt,
        finishedAt,
      });
      if (failure) {
        await tx.publish({
          type: 'routine.failed',
          payload: { routineName, businessDate, executionId, reason: failure.reason },
        });
        return;
      }
      await tx.insertAnchor({
        businessDate,
        seq: head.seq,
        hash: head.hash,
        objectKey,
        versionId,
        anchoredAt: finishedAt,
      });
      await tx.publish({
        type: 'routine.completed',
        payload: {
          routineName,
          businessDate,
          executionId,
          stats: { seq: head.seq, hash: head.hash },
        },
      });
    });
    if (failure) {
      this.d.onCriticalAlert({ kind: failure.alert, businessDate, detail: failure.reason });
      return 'BROKEN';
    }
    return 'ANCHORED';
  }

  /** Consulta à trilha (RN-AUD-005): a própria consulta entra na trilha antes de responder. */
  async query(filter: RecordFilter, who: Requester): Promise<AuditRecord[]> {
    const now = this.d.clock.now().toString();
    const { beforeSeq, limit, ...criteria } = filter;
    await this.d.store.transaction((tx) =>
      this.append(tx, {
        eventId: this.d.newId(),
        actorType: who.actor.type,
        actorId: who.actor.id,
        actorRoles: [...new Set(who.roles)].sort(),
        action: 'audit.records_queried',
        resourceType: 'audit_record',
        resourceId: null,
        before: null,
        after: mask({ ...criteria, ...(beforeSeq ? { beforeSeq } : {}), limit }),
        changedFields: [],
        justification: null,
        approvalRequestId: null,
        ip: who.ip ?? null,
        userAgent: who.userAgent ?? null,
        source: this.d.serviceName,
        occurredAt: now,
        recordedAt: now,
        correlationId: who.correlationId,
      }),
    );
    return this.d.store.find(filter);
  }
}
