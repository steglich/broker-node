// Eventos da Fase 1 → notificações do catálogo (Notificações §3). Cada função recebe o envelope já
// validado pelo consumidor e devolve o que o `Notifier` precisa; `null` = evento sem notificação.
import type { SourceEvent } from './notifier.js';

export interface Envelope {
  eventId: string;
  occurredAt: string;
  payload: unknown;
}

type Mapper = (e: Envelope) => SourceEvent | null;

// Rotas do app (RN-FE-050), as mesmas em todos os canais (RN-NOT-G-009).
const LINK = {
  statement: '/extrato',
  deposit: '/depositar',
  account: '/configuracoes/conta',
  security: '/configuracoes/seguranca',
  suitability: '/configuracoes/suitability',
  onboarding: '/cadastro',
};

const REFUND_REASONS: Record<string, string> = {
  THIRD_PARTY_PAYER: 'o PIX veio de uma conta que não é sua',
  AMOUNT_MISMATCH: 'o valor pago foi diferente do valor da cobrança',
  INTENT_EXPIRED: 'a cobrança já tinha expirado',
  INTENT_NOT_PENDING: 'a cobrança já tinha sido paga',
  ACCOUNT_NOT_ACTIVE: 'a sua conta não está ativa para depósitos',
  UNKNOWN_CHARGE: 'não encontramos a cobrança',
};

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'ativa',
  RESTRICTED: 'com restrições',
  BLOCKED: 'bloqueada',
  CLOSING: 'em encerramento',
  CLOSED: 'encerrada',
};

const DEVICE_CHANNELS: Record<string, string> = {
  WEB: 'navegador',
  MOBILE: 'celular',
  DESKTOP: 'plataforma desktop',
};

const p = <T>(e: Envelope) => e.payload as T;
const base = (e: Envelope) => ({ eventId: e.eventId, vars: { occurredAt: e.occurredAt } });

type Money = { accountId: string; amount: string; reason?: string };

export const SOURCES: Record<string, Mapper> = {
  'deposit.credited': (e) => {
    const x = p<Money & { depositId: string }>(e);
    return {
      ...base(e),
      code: 'DEPOSIT_CREDITED',
      recipient: { accountId: x.accountId },
      vars: { occurredAt: e.occurredAt, amount: x.amount },
      data: { depositId: x.depositId },
      deepLink: LINK.statement,
    };
  },
  'deposit.refunded': (e) => {
    const x = p<Money & { depositId: string }>(e);
    return {
      ...base(e),
      code: 'DEPOSIT_REFUNDED',
      recipient: { accountId: x.accountId },
      vars: {
        occurredAt: e.occurredAt,
        amount: x.amount,
        reason: REFUND_REASONS[x.reason ?? ''] ?? 'o pagamento não pôde ser aceito',
      },
      data: { depositId: x.depositId },
      deepLink: LINK.statement,
    };
  },
  'withdrawal.completed': (e) => {
    const x = p<Money & { withdrawalId: string }>(e);
    return {
      ...base(e),
      code: 'WITHDRAWAL_COMPLETED',
      recipient: { accountId: x.accountId },
      vars: { occurredAt: e.occurredAt, amount: x.amount },
      data: { withdrawalId: x.withdrawalId },
      deepLink: LINK.statement,
    };
  },
  // Recusa e falha do PIX são o mesmo aviso; o motivo livre do operador não vai para o cliente.
  'withdrawal.failed': (e) => withdrawalFailed(e, 'Não foi possível concluir o PIX.'),
  'withdrawal.rejected': (e) => withdrawalFailed(e, 'O saque foi recusado.'),
  'ledger.negative_balance_detected': (e) => {
    const x = p<{ accountId: string; settledBalance: string }>(e);
    return {
      ...base(e),
      code: 'NEGATIVE_BALANCE',
      recipient: { accountId: x.accountId },
      vars: { occurredAt: e.occurredAt, settledBalance: x.settledBalance },
      data: {},
      deepLink: LINK.deposit,
    };
  },
  'account.status_changed': (e) => {
    const x = p<{ accountId: string; from: string; to: string }>(e);
    if (x.from === x.to) return null;
    return {
      ...base(e),
      code: 'ACCOUNT_STATUS_CHANGED',
      recipient: { accountId: x.accountId },
      vars: { occurredAt: e.occurredAt, status: STATUS_LABELS[x.to] ?? x.to.toLowerCase() },
      data: { status: x.to },
      deepLink: LINK.account,
    };
  },
  'suitability.expiring': (e) => suitability(e, 'SUITABILITY_EXPIRING'),
  'suitability.expired': (e) => suitability(e, 'SUITABILITY_EXPIRED'),
  'onboarding.submitted': (e) => onboarding(e, 'ONBOARDING_SUBMITTED'),
  'onboarding.approved': (e) => onboarding(e, 'ONBOARDING_APPROVED'),
  'onboarding.rejected': (e) => onboarding(e, 'ONBOARDING_REJECTED'),
  'identity.new_device_detected': (e) => {
    const x = p<{ userId: string; deviceId: string; channel: string }>(e);
    return {
      ...base(e),
      code: 'SECURITY_NEW_DEVICE',
      recipient: { userId: x.userId },
      vars: { occurredAt: e.occurredAt, device: DEVICE_CHANNELS[x.channel] ?? 'dispositivo' },
      data: { deviceId: x.deviceId },
      deepLink: LINK.security,
    };
  },
  'identity.password_changed': (e) => securityChange(e, 'a sua senha'),
  'identity.trading_signature_changed': (e) => securityChange(e, 'a sua assinatura eletrônica'),
};

function withdrawalFailed(e: Envelope, detail: string): SourceEvent {
  const x = p<Money & { withdrawalId: string }>(e);
  return {
    ...base(e),
    code: 'WITHDRAWAL_FAILED',
    recipient: { accountId: x.accountId },
    vars: { occurredAt: e.occurredAt, amount: x.amount, detail },
    data: { withdrawalId: x.withdrawalId },
    deepLink: LINK.statement,
  };
}

function suitability(e: Envelope, code: string): SourceEvent {
  const x = p<{ customerId: string; validUntil: string }>(e);
  return {
    ...base(e),
    code,
    recipient: { customerId: x.customerId },
    vars: { occurredAt: e.occurredAt, validUntil: x.validUntil },
    data: {},
    deepLink: LINK.suitability,
  };
}

function onboarding(e: Envelope, code: string): SourceEvent {
  const x = p<{ applicationId: string }>(e);
  return {
    ...base(e),
    code,
    recipient: { applicationId: x.applicationId },
    data: { applicationId: x.applicationId },
    deepLink: LINK.onboarding,
  };
}

function securityChange(e: Envelope, what: string): SourceEvent {
  const x = p<{ userId: string; at: string }>(e);
  return {
    ...base(e),
    code: 'SECURITY_PASSWORD_CHANGED',
    recipient: { userId: x.userId },
    vars: { occurredAt: e.occurredAt, at: x.at, what },
    data: {},
    deepLink: LINK.security,
  };
}
