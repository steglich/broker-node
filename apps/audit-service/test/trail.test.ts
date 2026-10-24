// Trilha com PostgreSQL e MinIO reais: append-only encadeado (12.1), verificação e âncora diárias (12.2).
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DAILY_ROUTINE } from '../src/application/audit-trail.js';
import { AnchorConflictError, type CriticalAuditAlert } from '../src/application/ports.js';
import {
  app,
  BUCKET,
  captureAll,
  event,
  outbox,
  reset,
  startEnv,
  stopEnv,
  tamper,
  type Env,
} from './helpers.js';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
}, 180_000);
afterAll(() => stopEnv(env));
beforeEach(() => reset(env));

const trigger = (businessDate: string, executionId = crypto.randomUUID()) => ({
  routineName: DAILY_ROUTINE,
  businessDate,
  executionId,
});

describe('12.1 trilha append-only encadeada por hash (RN-AUD-001, RN-AUD-BO-002)', () => {
  it('grava os eventos auditáveis em seq contínuo, ignora os demais e não duplica', async () => {
    const a = await app(env);
    const created = event();
    await captureAll(a, [
      created,
      event({ eventType: 'quote.updated', auditable: false }),
      event({ eventType: 'audit.backoffice_query', auditable: false }),
      created, // reentrega do mesmo evento
    ]);
    const records = await a.store.recordsFrom(1, 10);
    expect(records.map((r) => [r.seq, r.action])).toEqual([
      [1, 'order.created'],
      [2, 'audit.backoffice_query'],
    ]);
    expect(records[0]).toMatchObject({
      actorId: 'user-1',
      source: 'oms-service',
      occurredAt: '2026-01-05T13:00:00.000Z',
      correlationId: created.correlationId,
    });
    expect(await a.trail.verify()).toEqual({
      ok: true,
      head: { seq: 2, hash: records[1]!.hash },
    });
  });

  it('appends concorrentes não quebram a cadeia', async () => {
    const a = await app(env);
    await Promise.all(
      Array.from({ length: 20 }, () => a.store.transaction((tx) => a.trail.capture(tx, event()))),
    );
    const result = await a.trail.verify();
    expect(result).toMatchObject({ ok: true, head: { seq: 20 } });
  });

  it('RN-AUD-004: o usuário da aplicação não altera nem apaga registros', async () => {
    const a = await app(env);
    await captureAll(a, [event()]);
    await expect(sql`UPDATE audit_record SET actor_id = 'x'`.execute(env.db)).rejects.toThrow(
      /permission denied/,
    );
    await expect(sql`DELETE FROM audit_record`.execute(env.db)).rejects.toThrow(
      /permission denied/,
    );
    await expect(sql`TRUNCATE audit_record`.execute(env.db)).rejects.toThrow(/permission denied/);
    // Mesmo com permissão (o superusuário), o gatilho recusa: segunda barreira.
    await expect(sql`DELETE FROM audit_record`.execute(env.superDb)).rejects.toThrow(
      /append-only|não permit/i,
    );
  });

  it('adulteração manual no banco é detectada pela verificação', async () => {
    const a = await app(env);
    await captureAll(a, [event(), event(), event()]);
    await tamper(env, sql`UPDATE audit_record SET actor_id = 'intruso' WHERE seq = 2`);
    expect(await a.trail.verify()).toMatchObject({
      ok: false,
      alert: 'CHAIN_BROKEN',
      break: { kind: 'HASH_MISMATCH', seq: 2 },
      head: { seq: 1 },
    });
  });

  it('apagar um registro do meio também é detectado (buraco no seq)', async () => {
    const a = await app(env);
    await captureAll(a, [event(), event(), event()]);
    await tamper(env, sql`DELETE FROM audit_record WHERE seq = 2`);
    expect(await a.trail.verify()).toMatchObject({
      ok: false,
      break: { kind: 'SEQ_GAP', seq: 3, expected: 2 },
    });
  });
});

describe('12.2 verificação diária e âncora imutável (RN-AUD-002)', () => {
  it('a rotina verifica, grava o hash final no bucket e responde routine.completed', async () => {
    const a = await app(env);
    await captureAll(a, [event(), event()]);
    const head = (await a.store.recordAt(2))!;
    const t = trigger('2026-01-05');

    expect(await a.trail.runDaily(t)).toBe('ANCHORED');
    const anchor = (await a.store.lastAnchor())!;
    expect(anchor).toMatchObject({
      businessDate: '2026-01-05',
      seq: 2,
      hash: head.hash,
      objectKey: 'test/2026-01-05.json',
    });
    const stored = await env.s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: anchor.objectKey }),
    );
    expect(JSON.parse(await stored.Body!.transformToString())).toEqual({
      businessDate: '2026-01-05',
      environment: 'test',
      hash: head.hash,
      seq: 2,
    });
    expect(await outbox(env.db)).toEqual([
      {
        event_type: 'routine.completed',
        payload: { ...t, stats: { seq: 2, hash: head.hash } },
      },
    ]);
    expect((await a.store.verifications(5))[0]).toMatchObject({
      status: 'OK',
      verifiedThroughSeq: 2,
    });

    // Re-disparo da mesma data: idempotente, responde de novo sem regravar a âncora.
    expect(await a.trail.runDaily(trigger('2026-01-05'))).toBe('ALREADY_ANCHORED');
    expect((await outbox(env.db)).map((e) => e.event_type)).toEqual([
      'routine.completed',
      'routine.completed',
    ]);
  });

  it('a âncora não pode ser sobrescrita nem apagada', async () => {
    const a = await app(env);
    await captureAll(a, [event()]);
    await a.trail.runDaily(trigger('2026-01-06'));
    const anchor = (await a.store.lastAnchor())!;

    // Pela aplicação: a chave do dia só é escrita uma vez.
    await expect(a.anchors.putOnce(anchor.objectKey, '{"hash":"falso"}')).rejects.toBeInstanceOf(
      AnchorConflictError,
    );
    // Direto no bucket: um PUT cria outra versão, mas a gravada continua lá e não pode ser apagada.
    await env.s3.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: anchor.objectKey, Body: '{"hash":"falso"}' }),
    );
    const original = await env.s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: anchor.objectKey,
        VersionId: anchor.versionId!,
      }),
    );
    expect(await original.Body!.transformToString()).toContain(anchor.hash);
    await expect(
      env.s3.send(
        new DeleteObjectCommand({
          Bucket: BUCKET,
          Key: anchor.objectKey,
          VersionId: anchor.versionId!,
        }),
      ),
    ).rejects.toThrow(/WORM protected/);
  });

  it('cadeia adulterada: alerta crítico, routine.failed e nenhuma âncora', async () => {
    const alerts: CriticalAuditAlert[] = [];
    const a = await app(env, { onCriticalAlert: (al) => alerts.push(al) });
    await captureAll(a, [event(), event()]);
    await tamper(env, sql`UPDATE audit_record SET after = '{"quantity": 1}' WHERE seq = 1`);

    expect(await a.trail.runDaily(trigger('2026-01-07'))).toBe('BROKEN');
    expect(alerts).toEqual([
      {
        kind: 'CHAIN_BROKEN',
        businessDate: '2026-01-07',
        detail: expect.stringContaining('seq 1') as unknown as string,
      },
    ]);
    expect(await a.store.lastAnchor()).toBeNull();
    const [failed] = await outbox(env.db);
    expect(failed).toMatchObject({
      event_type: 'routine.failed',
      payload: { routineName: DAILY_ROUTINE, businessDate: '2026-01-07' },
    });
    expect((await a.store.verifications(1))[0]).toMatchObject({
      status: 'BROKEN',
      broken: { kind: 'HASH_MISMATCH', seq: 1 },
    });
  });

  it('cadeia toda regravada (hashes coerentes) não bate com a âncora anterior', async () => {
    const alerts: CriticalAuditAlert[] = [];
    const a = await app(env, { onCriticalAlert: (al) => alerts.push(al) });
    await captureAll(a, [event()]);
    expect(await a.trail.runDaily(trigger('2026-01-08'))).toBe('ANCHORED');

    // O intruso apaga a trilha e grava outra, encadeada direitinho desde a gênese.
    await reset(env);
    const fresh = await app(env, { onCriticalAlert: (al) => alerts.push(al) });
    await captureAll(fresh, [event({ actor: { type: 'USER', id: 'outro' } })]);
    // Ele não consegue apagar a âncora do bucket; reponho a linha local que o reset apagou.
    const obj = 'test/2026-01-08.json';
    const body = JSON.parse(
      await (
        await env.s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: obj }))
      ).Body!.transformToString(),
    ) as { seq: number; hash: string };
    await tamper(
      env,
      sql`INSERT INTO audit_anchor (business_date, seq, hash, object_key, version_id, anchored_at)
          VALUES ('2026-01-08', ${body.seq}, ${body.hash}, ${obj}, NULL, now())`,
    );

    expect(await fresh.trail.runDaily(trigger('2026-01-09'))).toBe('BROKEN');
    expect(alerts.map((al) => al.kind)).toEqual(['ANCHOR_MISMATCH']);
  });
});
