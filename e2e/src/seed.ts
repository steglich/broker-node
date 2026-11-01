// Semente de clientes do ambiente local (RN-ENV-031): um usuário por cenário de KYC (penúltimo dígito
// do CPF, Onboarding §5.2) e saldo inicial para o aprovado. Tudo pela borda, com as mesmas jornadas
// do E2E; rodar de novo retoma cada cliente de onde ele está, sem duplicar usuário nem depósito.
// Uso: pnpm env:seed (ou pnpm --filter @broker/e2e run seed com o ambiente no ar).
import type { KycScenarioDigit } from '@broker/testing';
import { advanceClock, environmentClock } from './environment.js';
import {
  activeAccount,
  balances,
  completeOnboarding,
  customerProfile,
  deposit,
  kycDecision,
  signIn,
} from './journeys.js';

const SCENARIOS: { name: string; digit: KycScenarioDigit; expect: string; balance?: string }[] = [
  { name: 'kyc.aprovado', digit: 3, expect: 'APPROVED', balance: '10000.00' },
  { name: 'kyc.revisao-face-match', digit: 7, expect: 'MANUAL_REVIEW' },
  { name: 'kyc.revisao-watchlist', digit: 8, expect: 'MANUAL_REVIEW' },
  { name: 'kyc.reprovado', digit: 9, expect: 'REJECTED' },
];

// No modo VIRTUAL, o relógio do ambiente anda até o agora, se ainda não passou dele: o depósito
// vence por ele, e o pagamento chega com o horário real do Banco Simulado.
const clock = await environmentClock();
if (clock.mode === 'VIRTUAL') await advanceClock(new Date());

for (const [i, s] of SCENARIOS.entries()) {
  // Semente fixa por cenário: o mesmo CPF e o mesmo celular em toda execução.
  const c = customerProfile(s.name, s.digit, 20_000 + i);
  const web = await signIn(c);
  let view = await completeOnboarding(web, c);
  if (view.status === 'UNDER_REVIEW') view = await kycDecision(web);
  if (view.status !== s.expect)
    throw new Error(
      `${c.email}: esperado ${s.expect}, ficou ${view.status} (${view.decisionReason})`,
    );
  let line = `${c.email} (CPF ${c.taxId}): ${view.status}`;
  if (view.status === 'APPROVED') {
    const account = await activeAccount(web);
    line += `, conta ${account.accountNumber}`;
    if (s.balance && (await balances(web)).settled === '0.00') {
      await deposit(web, c.taxId, s.balance);
    }
    line += `, saldo R$ ${(await balances(web)).settled}`;
  }
  console.log(line);
}
console.log(`senha de todos: ${customerProfile('x', 3, 1).password}`);
