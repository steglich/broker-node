/**
 * Critério de pronto da Fase 1 (tarefa 20.1), contra o compose `core` com o relógio VIRTUAL:
 * cadastro → KYC aprovado → conta ativa → depósito PIX → cotação externa com defasagem sinalizada →
 * saque, terminando com INV-01 verificado (RN-QA-010). Tudo pela borda (Traefik → api-gateway →
 * bff-web), como o app web faria; os simuladores fazem o papel do cliente no banco e do KYC.
 *
 *   CLOCK_MODE=VIRTUAL pnpm env:up core && pnpm test:e2e
 *
 * O relógio virtual resolve o que o tempo real não deixa testar: a carência de 24 h da conta de
 * saque (RN-ACC-020) e a defasagem, que só existe durante o pregão (RN-BRP-070).
 */
import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
import { Instant } from '@broker/domain-kernel';
import { eventually } from '@broker/testing';
import { randomInt } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectStatus, http, urls } from '../src/edge.js';
import { advanceClock, environmentClock, verifyInv01 } from '../src/environment.js';
import {
  activeAccount,
  balances,
  bankAccountOf,
  completeOnboarding,
  customerProfile,
  deposit,
  enrollTotp,
  kycDecision,
  signIn,
  totp,
} from '../src/journeys.js';

const calendar = new TradingCalendar(b3Calendar2026To2027);
const SIGNATURE = '246813';

/** Meio do pregão contínuo do primeiro dia útil em que `notBefore` já passou. */
function insideSessionAfter(notBefore: Instant): Date {
  for (let d = notBefore.businessDate(); ; d = d.plusDays(1)) {
    const continuous = calendar.sessionSchedule(d)?.phases.find((p) => p.phase === 'CONTINUOUS');
    if (!continuous) continue;
    const at = continuous.startsAt.plusMillis(2 * 3_600_000);
    if (!at.isBefore(notBefore)) return new Date(at.epochMillis);
  }
}

beforeAll(async () => {
  const clock = await environmentClock();
  if (clock.mode !== 'VIRTUAL')
    throw new Error(
      `o E2E da Fase 1 precisa do relógio VIRTUAL (atual: ${clock.mode}); suba com CLOCK_MODE=VIRTUAL pnpm env:up core`,
    );
  // Começa no agora real (ou logo depois do instante virtual, se uma execução anterior já o
  // adiantou): o depósito vence pelo relógio do ambiente, e o pagamento chega com o horário real.
  await advanceClock(new Date());
});

describe('Fase 1 — critério de pronto (E2E pela borda)', () => {
  it('cadastro → KYC aprovado → conta ativa → depósito PIX → cotação defasada → saque, com INV-01', async () => {
    // KYC: penúltimo dígito do CPF entre 0 e 6 aprova (Onboarding §5.2).
    const c = customerProfile(`e2e.fase1.${Date.now()}`, 3, randomInt(1, 2 ** 31));
    let web = await signIn(c);

    // 1) Onboarding completo e submissão ao KYC simulado.
    const submitted = await completeOnboarding(web, c);
    expect(submitted.status).toBe('UNDER_REVIEW');
    const decision = await kycDecision(web);
    expect(decision).toMatchObject({ status: 'APPROVED', decisionReason: 'KYC_APPROVED' });

    // 2) Saga de abertura: conta ativa no cadastro, no ledger e no Banco Simulado.
    const account = await activeAccount(web);
    expect(account.accountNumber).toMatch(/^\d{7}-\d$/);
    const bank = await bankAccountOf(c.taxId);
    const bankBefore = Number(bank.saldo);

    // 3) Depósito PIX: cobrança → pagamento no banco → webhook assinado → crédito.
    const credited = await deposit(web, c.taxId, '1500.00');
    expect(credited).toMatchObject({ status: 'CREDITED', amount: '1500.00' });
    expect(await balances(web)).toMatchObject({ settled: '1500.00', withdrawable: '1500.00' });

    // 4) Autenticador, assinatura eletrônica e conta de saque (a chave CPF do próprio cliente),
    // que exige MFA nos últimos 15 min (RN-AUTHZ-003). O TOTP segue o relógio do ambiente, e um
    // código não vale duas vezes: o step-up usa o passo de 30 s seguinte ao da ativação.
    const at = async () => Date.parse((await environmentClock()).now);
    const totpSecret = await enrollTotp(web, await at());
    await advanceClock(new Date((await at()) + 30_000));
    expectStatus(
      await web.post('/v1/me/step-up', { method: 'TOTP', code: totp(totpSecret, await at()) }),
      200,
    );
    expectStatus(await web.put('/v1/me/trading-signature', { secret: SIGNATURE }), 204);
    expectStatus(
      await web.post('/v1/me/trading-signature/verify', { secret: SIGNATURE, scope: 'SETTINGS' }),
      200,
    );
    const added = expectStatus(
      await web.post<{ id: string; availableFrom: string }>('/v1/me/withdrawal-accounts', {
        pixKey: c.taxId,
      }),
      201,
    ).body;
    // Ainda na carência de 24 h: o saque é recusado (RN-SAQ-002).
    expectStatus(
      await web.post('/v1/me/trading-signature/verify', {
        secret: SIGNATURE,
        scope: 'WITHDRAWALS',
      }),
      200,
    );
    const early = await web.post<{ code: string }>('/v1/me/withdrawals', {
      amount: '100.00',
      bankAccountId: added.id,
    });
    expect(early.status, JSON.stringify(early.body)).toBe(422);
    expect(early.body.code).toBe('BANK_ACCOUNT_NOT_ALLOWED');

    // 5) Cotação externa pelo canal: grava a leitura das fixtures (fora do pregão, sem defasagem).
    const symbol = 'PETR4';
    const quotes = async () =>
      expectStatus(
        await web.get<{
          items: { symbol: string; quote?: { stale: boolean; staleSince: string | null } }[];
        }>(`/v1/market/quotes?symbols=${symbol}`),
        200,
      ).body.items[0]!;
    expect((await quotes()).quote).toBeDefined();

    // 6) O relógio anda até o pregão seguinte ao fim da carência.
    const target = insideSessionAfter(Instant.parse(added.availableFrom));
    await advanceClock(target);

    // A web encerra a sessão depois de 30 min sem uso (RN-AUTH-012): entra de novo, agora com MFA.
    const now = await at();
    web = await signIn(c, () => totp(totpSecret, now));

    // A leitura gravada é antiga para o pregão de agora: o market-data marca a defasagem e o canal
    // a exibe (RN-BRP-070/081).
    const stale = await eventually(
      async () => {
        const item = await quotes();
        if (!item.quote?.stale) throw new Error(`ainda sem defasagem: ${JSON.stringify(item)}`);
        return item.quote;
      },
      { timeoutMs: 60_000, intervalMs: 1000 },
    );
    expect(stale.staleSince).not.toBeNull();

    // 7) Saque fora da carência: hold → PIX para a chave do cliente → débito.
    expectStatus(
      await web.post('/v1/me/trading-signature/verify', {
        secret: SIGNATURE,
        scope: 'WITHDRAWALS',
      }),
      200,
    );
    const requested = expectStatus(
      await web.post<{ id: string; status: string }>('/v1/me/withdrawals', {
        amount: '400.00',
        bankAccountId: added.id,
      }),
      202,
    ).body;
    const completed = await eventually(
      async () => {
        const w = expectStatus(
          await web.get<{ status: string; endToEndId?: string }>(
            `/v1/me/withdrawals/${requested.id}`,
          ),
          200,
        ).body;
        if (w.status !== 'COMPLETED') throw new Error(`saque ${w.status}`);
        return w;
      },
      { timeoutMs: 60_000, intervalMs: 1000 },
    );
    expect(completed.endToEndId).toMatch(/^ESIM/);
    // O hold consumido volta ao ledger por `risk.hold_consumed`: até lá, o sacável segue descontado.
    await eventually(
      async () =>
        expect(await balances(web)).toMatchObject({ settled: '1100.00', withdrawable: '1100.00' }),
      { timeoutMs: 30_000, intervalMs: 500 },
    );

    // O dinheiro saiu do banco no depósito e voltou no saque.
    const bankAfter = expectStatus(
      await http<{ saldo: string }>(`${urls.bank}/contas/${bank.id}`),
      200,
    ).body;
    expect(Number(bankAfter.saldo)).toBeCloseTo(bankBefore - 1500 + 400, 2);

    // 8) Reconciliação: INV-01 sem diferença no ledger inteiro.
    const inv01 = await verifyInv01();
    expect(inv01.entries).toBeGreaterThan(0);
  });
});
