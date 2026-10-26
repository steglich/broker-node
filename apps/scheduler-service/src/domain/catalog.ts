import type { RoutineDefinition } from './routines.js';

const trading = (
  name: string,
  owner: string,
  schedule: RoutineDefinition['schedule'],
  dependsOn: string[] = [],
): RoutineDefinition => ({ name, owner, schedule, days: 'TRADING', dependsOn, enabled: true });

/**
 * Tabela de rotinas do dia (Pregão §8), semeada em `routine_definition`. As fases do pregão vêm da
 * grade do calendário (`phase`), então mudam sozinhas nos dias especiais; as demais têm horário
 * fixo de São Paulo. As dependências seguem o fluxo de fim de dia (Mensageria, Fluxos §5).
 */
export const DEFAULT_ROUTINES: readonly RoutineDefinition[] = [
  trading('calendar_check', 'trading-session', { at: '07:00' }),
  trading('settlement', 'clearing-service', { at: '08:00' }),
  trading('corporate_actions_ex_date', 'corporate-actions-service', { at: '08:30' }),
  trading('securities_lending_renewal', 'securities-lending-service', { at: '08:45' }),
  trading('pre_trading', 'trading-session', { phase: 'PRE_TRADING' }, ['calendar_check']),
  trading('pre_opening', 'trading-session', { phase: 'PRE_OPENING' }, ['pre_trading']),
  trading('continuous', 'trading-session', { phase: 'CONTINUOUS' }, ['pre_opening']),
  // 30 min antes do fim do pregão contínuo (Risco: encerramento do day trade alavancado).
  trading('leveraged_day_trade_close', 'risk-service', {
    phase: 'CLOSING_CALL',
    offsetMinutes: -30,
  }),
  trading('closing_call', 'trading-session', { phase: 'CLOSING_CALL' }, ['continuous']),
  trading('post_close', 'trading-session', { phase: 'POST_CLOSE' }, ['closing_call']),
  trading('eod_orders', 'oms-service', { at: '17:05' }, ['post_close']),
  // Notas só depois do fechamento e do fim das ordens do dia (RN-ROT-002).
  trading('brokerage_notes', 'clearing-service', { at: '17:10' }, ['post_close', 'eod_orders']),
  trading('daily_close', 'market-data-service', { phase: 'CLOSED' }, ['post_close']),
  trading('brapi_close_snapshot', 'market-data-service', { at: '18:00' }, ['daily_close']),
  trading('negative_balance_interest', 'ledger-service', { at: '19:00' }, ['brokerage_notes']),
  trading('margin_eod', 'risk-service', { at: '19:00' }, ['brokerage_notes']),
  trading('reconciliations', 'ledger-service', { at: '23:00' }, [
    'brokerage_notes',
    'negative_balance_interest',
  ]),
  // Verificação da cadeia da trilha e âncora do dia (RN-AUD-001/002), depois do expediente.
  trading('audit_chain_verify', 'audit-service', { at: '23:30' }),
  // Expirações do onboarding (30 dias), do suitability (24 meses) e do cadastro (RN-ONB-002,
  // RN-SUI-012, RN-CAD-003), depois do pregão.
  trading('customer_daily', 'customer-service', { at: '22:00' }),
  // Reconciliação PIX do ledger com o Banco Simulado (RN-PIXS-002). Sem dependências: o PIX roda
  // 24/7 e a janela de cada execução começa onde a anterior parou.
  trading('pix_reconciliation', 'ledger-service', { at: '23:15' }),
  {
    name: 'custody_fee',
    owner: 'ledger-service',
    schedule: { at: '07:30' },
    days: 'FIRST_BUSINESS_DAY_OF_MONTH',
    dependsOn: [],
    enabled: true,
  },
  {
    name: 'monthly_tax_assessment',
    owner: 'tax-service',
    schedule: { at: '07:30' },
    days: 'FIRST_BUSINESS_DAY_OF_MONTH',
    dependsOn: [],
    enabled: true,
  },
];
