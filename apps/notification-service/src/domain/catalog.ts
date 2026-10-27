// Catálogo de notificações (Notificações §3): canais padrão, prioridade, se pode desativar e o
// texto genérico do push com "ocultar valores" (RN-NOT-G-003).

export const CHANNELS = ['IN_APP', 'PUSH', 'EMAIL', 'SMS', 'DESKTOP'] as const;
export type Channel = (typeof CHANNELS)[number];
/** Canais entregues por um provedor externo, com retentativa (RN-NOT-G-007). */
export const EXTERNAL_CHANNELS = ['PUSH', 'EMAIL', 'SMS'] as const;
export type ExternalChannel = (typeof EXTERNAL_CHANNELS)[number];
export const isExternal = (c: Channel): c is ExternalChannel =>
  (EXTERNAL_CHANNELS as readonly string[]).includes(c);

export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface CatalogEntry {
  code: string;
  priority: Priority;
  channels: readonly Channel[];
  canDisable: boolean;
  /** Ligada quando o cliente nunca mexeu (o `DAILY_SUMMARY` nasce desligado). */
  enabledByDefault: boolean;
  /** Segurança: nunca silenciada, mesmo de prioridade alta (RN-NOT-G-006). */
  security: boolean;
  /** Push com "ocultar valores" ativo. */
  hiddenText: string;
  /** Agrupamento (RN-NOT-G-005): a variável que identifica o recurso e a janela. */
  group?: { by: string; windowMs: number };
}

type Def = Omit<CatalogEntry, 'code' | 'enabledByDefault' | 'security'> &
  Partial<Pick<CatalogEntry, 'enabledByDefault' | 'security'>>;

const ORDER = 'Há uma atualização de uma ordem sua.';
const MONEY = 'Há uma movimentação na sua conta.';
const RISK = 'Há um aviso importante sobre a sua conta.';
const DOCS = 'Há um documento novo disponível.';
const SECURITY = 'Há um aviso de segurança da sua conta.';

const DEFS: Record<string, Def> = {
  ORDER_FILLED: {
    priority: 'HIGH',
    channels: ['IN_APP', 'PUSH', 'DESKTOP'],
    canDisable: true,
    hiddenText: ORDER,
  },
  ORDER_PARTIALLY_FILLED: {
    priority: 'MEDIUM',
    channels: ['IN_APP', 'DESKTOP'],
    canDisable: true,
    hiddenText: ORDER,
    group: { by: 'orderId', windowMs: 5_000 },
  },
  ORDER_REJECTED: {
    priority: 'HIGH',
    channels: ['IN_APP', 'PUSH', 'DESKTOP'],
    canDisable: false,
    hiddenText: ORDER,
  },
  ORDER_CANCELED_BY_SYSTEM: {
    priority: 'HIGH',
    channels: ['IN_APP', 'PUSH'],
    canDisable: false,
    hiddenText: ORDER,
  },
  STOP_TRIGGERED: {
    priority: 'HIGH',
    channels: ['IN_APP', 'PUSH', 'DESKTOP'],
    canDisable: true,
    hiddenText: ORDER,
  },
  PRICE_ALERT: {
    priority: 'HIGH',
    channels: ['IN_APP', 'PUSH', 'DESKTOP'],
    canDisable: true,
    hiddenText: 'Um alerta de preço seu disparou.',
  },
  DEPOSIT_CREDITED: {
    priority: 'MEDIUM',
    channels: ['IN_APP', 'PUSH', 'EMAIL'],
    canDisable: false,
    hiddenText: MONEY,
  },
  DEPOSIT_REFUNDED: {
    priority: 'MEDIUM',
    channels: ['IN_APP', 'PUSH', 'EMAIL'],
    canDisable: false,
    hiddenText: MONEY,
  },
  WITHDRAWAL_COMPLETED: {
    priority: 'HIGH',
    channels: ['IN_APP', 'PUSH', 'EMAIL'],
    canDisable: false,
    hiddenText: MONEY,
  },
  WITHDRAWAL_FAILED: {
    priority: 'HIGH',
    channels: ['IN_APP', 'PUSH', 'EMAIL'],
    canDisable: false,
    hiddenText: MONEY,
  },
  MARGIN_WARNING: {
    priority: 'HIGH',
    channels: ['IN_APP', 'PUSH', 'EMAIL'],
    canDisable: false,
    hiddenText: RISK,
  },
  MARGIN_CALL: {
    priority: 'CRITICAL',
    channels: ['IN_APP', 'PUSH', 'EMAIL', 'SMS'],
    canDisable: false,
    hiddenText: RISK,
  },
  FORCED_LIQUIDATION: {
    priority: 'CRITICAL',
    channels: ['IN_APP', 'PUSH', 'EMAIL', 'SMS'],
    canDisable: false,
    hiddenText: RISK,
  },
  DAY_TRADE_WARNING: {
    priority: 'HIGH',
    channels: ['IN_APP', 'PUSH', 'DESKTOP'],
    canDisable: false,
    hiddenText: RISK,
  },
  NEGATIVE_BALANCE: {
    priority: 'HIGH',
    channels: ['IN_APP', 'PUSH', 'EMAIL'],
    canDisable: false,
    hiddenText: RISK,
  },
  CORPORATE_ACTION_UPCOMING: {
    priority: 'LOW',
    channels: ['IN_APP'],
    canDisable: true,
    hiddenText: 'Há um provento próximo de um ativo seu.',
  },
  CORPORATE_ACTION_PAID: {
    priority: 'MEDIUM',
    channels: ['IN_APP', 'PUSH'],
    canDisable: true,
    hiddenText: MONEY,
  },
  BROKERAGE_NOTE_AVAILABLE: {
    priority: 'LOW',
    channels: ['IN_APP', 'EMAIL'],
    canDisable: true,
    hiddenText: DOCS,
  },
  DARF_AVAILABLE: {
    priority: 'MEDIUM',
    channels: ['IN_APP', 'EMAIL', 'PUSH'],
    canDisable: false,
    hiddenText: DOCS,
  },
  DARF_DUE_SOON: {
    priority: 'MEDIUM',
    channels: ['IN_APP', 'EMAIL', 'PUSH'],
    canDisable: false,
    hiddenText: DOCS,
  },
  BTC_RECALL: {
    priority: 'HIGH',
    channels: ['IN_APP', 'PUSH', 'EMAIL'],
    canDisable: false,
    hiddenText: RISK,
  },
  SUITABILITY_EXPIRING: {
    priority: 'MEDIUM',
    channels: ['IN_APP', 'EMAIL'],
    canDisable: false,
    hiddenText: RISK,
  },
  // Extensão do catálogo: o vencimento em si (suitability.expired) também avisa o cliente.
  SUITABILITY_EXPIRED: {
    priority: 'MEDIUM',
    channels: ['IN_APP', 'EMAIL'],
    canDisable: false,
    hiddenText: RISK,
  },
  SECURITY_NEW_DEVICE: {
    priority: 'CRITICAL',
    channels: ['EMAIL', 'PUSH'],
    canDisable: false,
    security: true,
    hiddenText: SECURITY,
  },
  SECURITY_PASSWORD_CHANGED: {
    priority: 'CRITICAL',
    channels: ['EMAIL', 'SMS'],
    canDisable: false,
    security: true,
    hiddenText: SECURITY,
  },
  ACCOUNT_STATUS_CHANGED: {
    priority: 'HIGH',
    channels: ['IN_APP', 'EMAIL'],
    canDisable: false,
    hiddenText: RISK,
  },
  ONBOARDING_SUBMITTED: {
    priority: 'MEDIUM',
    channels: ['EMAIL', 'IN_APP'],
    canDisable: false,
    hiddenText: 'Há uma atualização do seu cadastro.',
  },
  ONBOARDING_APPROVED: {
    priority: 'MEDIUM',
    channels: ['EMAIL', 'IN_APP'],
    canDisable: false,
    hiddenText: 'Há uma atualização do seu cadastro.',
  },
  ONBOARDING_REJECTED: {
    priority: 'MEDIUM',
    channels: ['EMAIL', 'IN_APP'],
    canDisable: false,
    hiddenText: 'Há uma atualização do seu cadastro.',
  },
  DAILY_SUMMARY: {
    priority: 'LOW',
    channels: ['EMAIL', 'IN_APP'],
    canDisable: true,
    enabledByDefault: false,
    hiddenText: 'O resumo do dia está disponível.',
  },
};

export const CATALOG: ReadonlyMap<string, CatalogEntry> = new Map(
  Object.entries(DEFS).map(([code, d]) => [
    code,
    { code, enabledByDefault: true, security: false, ...d },
  ]),
);

export const catalogEntry = (code: string): CatalogEntry | undefined => CATALOG.get(code);

/** Preferências gravadas do cliente: `code → canal → ligado`. */
export type PreferenceMap = ReadonlyMap<string, ReadonlyMap<Channel, boolean>>;

/**
 * Canais efetivos (Notificações §3): as obrigatórias ignoram a preferência; as opcionais seguem
 * o que o cliente gravou e, sem nada gravado, o padrão do código.
 */
export function effectiveChannels(entry: CatalogEntry, prefs: PreferenceMap): Channel[] {
  if (!entry.canDisable) return [...entry.channels];
  const saved = prefs.get(entry.code);
  return entry.channels.filter((c) => saved?.get(c) ?? entry.enabledByDefault);
}

/** RN-NOT-G-006: só PUSH e EMAIL de prioridade baixa e média; segurança e crítica nunca. */
export const silenceable = (entry: CatalogEntry, channel: Channel): boolean =>
  (channel === 'PUSH' || channel === 'EMAIL') &&
  (entry.priority === 'LOW' || entry.priority === 'MEDIUM') &&
  !entry.security;
