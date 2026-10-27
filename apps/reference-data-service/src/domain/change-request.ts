import type { Instant } from '@broker/domain-kernel';
import { ReferenceRuleError } from './errors.js';

/**
 * Dupla aprovação local (Backoffice §4) para as ações do reference-data que a matriz exige
 * (Backoffice §3). Na Fase 3 o approval-service assume o fluxo e este serviço só executa ao
 * consumir `approval.request_approved`, com a mesma idempotência pelo id da solicitação.
 */
export type ChangeRequestType =
  'UNIVERSE_INCLUDE' | 'UNIVERSE_REMOVE' | 'TRADING_RULES' | 'CALENDAR' | 'SESSION_SCHEDULE';

/** RN-MC-BO-002/003. */
export type ChangeRequestStatus =
  'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELED' | 'STALE';

export const DEFAULT_REQUEST_TTL_HOURS = 24;

/** Quem propõe e quem aprova cada tipo (Backoffice §3). */
export const POLICY: Record<ChangeRequestType, { makers: string[]; checkers: string[] }> = {
  UNIVERSE_INCLUDE: { makers: ['BO_MARKET'], checkers: ['BO_ADMIN'] },
  UNIVERSE_REMOVE: { makers: ['BO_MARKET'], checkers: ['BO_ADMIN'] },
  TRADING_RULES: { makers: ['BO_MARKET'], checkers: ['BO_MARKET', 'BO_ADMIN'] },
  CALENDAR: { makers: ['BO_MARKET'], checkers: ['BO_MARKET', 'BO_ADMIN'] },
  SESSION_SCHEDULE: { makers: ['BO_MARKET'], checkers: ['BO_MARKET', 'BO_ADMIN'] },
};

export interface ChangeRequest {
  id: string;
  type: ChangeRequestType;
  /** Recurso alvo (instrument_id, escopo das regras, `calendar`). */
  targetId: string;
  payload: Record<string, unknown>;
  /** Estado do recurso na criação, comparado na aprovação (RN-MC-BO-003). */
  currentState: Record<string, unknown>;
  justification: string;
  makerId: string;
  status: ChangeRequestStatus;
  createdAt: Instant;
  expiresAt: Instant;
  decidedBy: string | null;
  decidedAt: Instant | null;
  decisionReason: string | null;
}

interface Actor {
  id: string;
  roles: readonly string[];
}

export function assertMaker(type: ChangeRequestType, op: Actor): void {
  if (!POLICY[type].makers.some((r) => op.roles.includes(r)))
    throw new ReferenceRuleError('FORBIDDEN_MAKER', `Seu papel não propõe ${type}.`);
}

/** RN-MC-BO-002, RN-BO-001: pendente, no prazo, papel do checker e nunca o próprio maker. */
export function assertCanDecide(r: ChangeRequest, op: Actor, now: Instant): void {
  if (r.status !== 'PENDING')
    throw new ReferenceRuleError('REQUEST_NOT_PENDING', `A solicitação está ${r.status}.`);
  if (!now.isBefore(r.expiresAt))
    throw new ReferenceRuleError('REQUEST_EXPIRED', 'A solicitação expirou.');
  if (r.makerId === op.id)
    throw new ReferenceRuleError(
      'MAKER_CANNOT_APPROVE',
      'Quem propôs não pode decidir a própria solicitação.',
    );
  if (!POLICY[r.type].checkers.some((role) => op.roles.includes(role)))
    throw new ReferenceRuleError(
      'CHECKER_ROLE_REQUIRED',
      `A decisão exige o papel ${POLICY[r.type].checkers.join(' ou ')}.`,
    );
}

/** RN-MC-BO-003: o estado mudou desde a criação? */
export const isStale = (r: ChangeRequest, state: Record<string, unknown>) =>
  canonical(r.currentState) !== canonical(state);

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
