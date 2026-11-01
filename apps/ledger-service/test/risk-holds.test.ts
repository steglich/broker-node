// 24.3 o adaptador do RPC do Risco: contrato do pedido, recusa e a cópia dos holds no sacável.
import { Money } from '@broker/domain-kernel';
import { uuidv7 } from '@broker/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RpcRiskHoldPort } from '../src/adapters/risk-holds.js';
import { startEnv, stopEnv, app, type App, type Env } from './helpers.js';

let env: Env;
let a: App;
beforeAll(async () => {
  env = await startEnv();
  a = await app(env);
}, 180_000);
afterAll(() => stopEnv(env));

const brl = (v: string) => Money.of(v, 'BRL');

describe('RpcRiskHoldPort (Contratos §10.2)', () => {
  const port = (decision: 'APPROVED' | 'REJECTED') => {
    const calls: { method: string; path: string; body?: unknown; idempotencyKey?: string }[] = [];
    const rpc = {
      call: <T>(req: { method: string; path: string; body?: unknown; idempotencyKey?: string }) => {
        calls.push(req);
        return Promise.resolve({ status: 200, body: { decision } as T });
      },
    };
    return { calls, holds: new RpcRiskHoldPort({ rpc: rpc as never, store: a.store }) };
  };

  it('RN-LED-030: o id do saque é o requestId, o hold_id e a chave de idempotência', async () => {
    const { calls, holds } = port('APPROVED');
    const id = uuidv7();
    const accountId = uuidv7();
    expect(await holds.createHold({ holdId: id, accountId, amount: brl('12.30') })).toEqual({
      approved: true,
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/internal/risk/holds',
      idempotencyKey: id,
      body: {
        requestId: id,
        holdType: 'WITHDRAWAL',
        accountId,
        amount: '12.30',
        reference: { type: 'WITHDRAWAL', id },
      },
    });
  });

  it('recusa do Risco vira INSUFFICIENT_WITHDRAWABLE_BALANCE', async () => {
    const { holds } = port('REJECTED');
    expect(
      await holds.createHold({ holdId: uuidv7(), accountId: uuidv7(), amount: brl('1.00') }),
    ).toEqual({ approved: false, code: 'INSUFFICIENT_WITHDRAWABLE_BALANCE' });
  });

  it('RN-LED-032: consumir e liberar viram ReleaseHold com o outcome', async () => {
    const { calls, holds } = port('APPROVED');
    const id = uuidv7();
    await holds.consumeHold(id);
    await holds.releaseHold(id);
    expect(calls.map((c) => c.body)).toEqual([{ outcome: 'CONSUMED' }, { outcome: 'CANCELED' }]);
    expect(calls[0]!.path).toBe(`/v1/internal/risk/holds/${id}/release`);
  });

  it('Financeiro §4: o sacável desconta a cópia alimentada por risk.hold_*', async () => {
    const { holds } = port('APPROVED');
    const accountId = uuidv7();
    const [first, second] = [uuidv7(), uuidv7()];
    await a.store.transaction(async (tx) => {
      await tx.upsertHoldCopy({ holdId: first, accountId, amount: brl('100.00') });
      await tx.upsertHoldCopy({ holdId: second, accountId, amount: brl('50.00') });
      await tx.upsertHoldCopy({ holdId: first, accountId, amount: brl('60.00') });
    });
    expect((await holds.activeHolds(accountId)).toString()).toBe('110.00');
    await a.store.transaction((tx) => tx.deleteHoldCopy(second));
    expect((await holds.activeHolds(accountId)).toString()).toBe('60.00');
  });
});
