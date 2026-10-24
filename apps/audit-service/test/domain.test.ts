// Domínio da trilha: conteúdo canônico, encadeamento, verificação e mascaramento (sem banco).
import { describe, expect, it } from 'vitest';
import { changedFields, entryFromEvent, isAuditable, mask, MASK } from '../src/domain/capture.js';
import {
  canonicalJson,
  chain,
  ChainVerifier,
  GENESIS_HASH,
  type AuditRecord,
} from '../src/domain/record.js';
import { event } from './helpers.js';

const RECORDED_AT = '2026-01-05T13:00:01.000Z';

function buildChain(n: number): AuditRecord[] {
  const out: AuditRecord[] = [];
  for (let i = 0; i < n; i++) {
    out.push(chain(out[i - 1] ?? null, entryFromEvent(event(), RECORDED_AT)));
  }
  return out;
}

describe('cadeia de hash (RN-AUD-001)', () => {
  it('JSON canônico não depende da ordem das chaves', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
  });

  it('seq começa em 1 a partir da gênese e cada registro guarda o hash do anterior', () => {
    const [r1, r2, r3] = buildChain(3);
    expect(r1!.seq).toBe(1);
    expect(r1!.prevHash).toBe(GENESIS_HASH);
    expect(r2!.prevHash).toBe(r1!.hash);
    expect(r3!.prevHash).toBe(r2!.hash);
    expect(new Set([r1!.hash, r2!.hash, r3!.hash]).size).toBe(3);
  });

  it('a verificação aceita a cadeia íntegra, inclusive em lotes', () => {
    const records = buildChain(5);
    const v = new ChainVerifier();
    expect(v.feed(records.slice(0, 2))).toBe(true);
    expect(v.feed(records.slice(2))).toBe(true);
    expect(v.result()).toEqual({ ok: true, head: { seq: 5, hash: records[4]!.hash } });
  });

  it('detecta conteúdo alterado, elo trocado e buraco no seq', () => {
    const altered = buildChain(4);
    altered[2] = { ...altered[2]!, actorId: 'outro' };
    const v1 = new ChainVerifier();
    v1.feed(altered);
    expect(v1.result()).toMatchObject({
      ok: false,
      head: { seq: 2 },
      break: { kind: 'HASH_MISMATCH', seq: 3 },
    });

    // Recalcular o hash do registro alterado não basta: o próximo aponta para o hash antigo.
    const rehashed = buildChain(4);
    rehashed[1] = chain(rehashed[0]!, { ...rehashed[1]!, action: 'order.cancelled' });
    const v2 = new ChainVerifier();
    v2.feed(rehashed);
    expect(v2.result()).toMatchObject({ ok: false, break: { kind: 'PREV_HASH_MISMATCH', seq: 3 } });

    const gap = buildChain(4);
    gap.splice(1, 1);
    const v3 = new ChainVerifier();
    v3.feed(gap);
    expect(v3.result()).toMatchObject({
      ok: false,
      break: { kind: 'SEQ_GAP', seq: 3, expected: 2 },
    });
  });
});

describe('captura e mascaramento (RN-AUD-003, RN-AUD-BO-001)', () => {
  it('troca de telefone: registra que mudou, sem gravar o número', () => {
    const e = event({
      eventType: 'audit.customer_contact_changed',
      auditable: false,
      actor: { type: 'BACKOFFICE', id: 'op-7' },
      payload: {
        actorRoles: ['BO_SUPPORT'],
        resourceType: 'customer',
        resourceId: 'cus-1',
        before: { phone: '+5511988887777', name: 'Ana' },
        after: { phone: '+5511999990000', name: 'Ana' },
        justification: 'pedido do cliente pelo chat',
        approvalRequestId: 'apr-9',
        ip: '10.0.0.5',
        userAgent: 'Mozilla/5.0',
      },
    });
    const entry = entryFromEvent(e, RECORDED_AT);
    expect(entry).toMatchObject({
      actorType: 'BACKOFFICE',
      actorId: 'op-7',
      actorRoles: ['BO_SUPPORT'],
      action: 'audit.customer_contact_changed',
      resourceType: 'customer',
      resourceId: 'cus-1',
      before: { phone: MASK, name: 'Ana' },
      after: { phone: MASK, name: 'Ana' },
      changedFields: ['phone'],
      justification: 'pedido do cliente pelo chat',
      approvalRequestId: 'apr-9',
      ip: '10.0.0.5',
      userAgent: 'Mozilla/5.0',
      correlationId: e.correlationId,
    });
    expect(JSON.stringify(entry)).not.toContain('99990000');
    expect(JSON.stringify(entry)).not.toContain('88887777');
  });

  it('evento de domínio auditável: recurso é o agregado e o after é o payload', () => {
    const entry = entryFromEvent(
      event({ payload: { orderId: 'o-1', quantity: 100, pixKey: 'ana@x.com' } }),
      RECORDED_AT,
    );
    expect(entry).toMatchObject({
      action: 'order.created',
      resourceType: 'order',
      resourceId: 'acc-1',
      before: null,
      after: { orderId: 'o-1', quantity: 100, pixKey: MASK },
      changedFields: [],
    });
  });

  it('só eventos auditable ou audit.* entram na trilha', () => {
    expect(isAuditable({ auditable: true, eventType: 'order.created' })).toBe(true);
    expect(isAuditable({ auditable: false, eventType: 'audit.backoffice_query' })).toBe(true);
    expect(isAuditable({ auditable: false, eventType: 'quote.updated' })).toBe(false);
  });

  it('mascara em qualquer nível, ignorando caixa e separadores', () => {
    expect(mask({ a: [{ Phone_Number: '1', ok: 2 }], token: 'x', cpf: null })).toEqual({
      a: [{ Phone_Number: MASK, ok: 2 }],
      token: MASK,
      cpf: null,
    });
    expect(changedFields({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 }, d: 4 })).toEqual(['a.c', 'd']);
  });
});
