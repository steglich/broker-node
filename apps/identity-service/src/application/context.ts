import type { Clock } from '@broker/clock';
import type { Instant } from '@broker/domain-kernel';
import type { Channel, Realm } from '../domain/policies.js';
import type {
  FieldProtection,
  IdentityStore,
  IdentityTx,
  Messenger,
  Randomness,
  RevocationList,
  SecretHasher,
  SessionRow,
  TokenSigner,
  TotpPort,
  UserRow,
  WebAuthnPort,
} from './ports.js';

export interface IdentityDeps {
  store: IdentityStore;
  clock: Clock;
  newId: () => string;
  hasher: SecretHasher;
  fields: FieldProtection;
  random: Randomness;
  signer: TokenSigner;
  revocation: RevocationList;
  totp: TotpPort;
  webauthn: WebAuthnPort;
  messenger: Messenger;
  /** Endereços públicos usados nos e-mails (link de recuperação e convite). */
  links: { recovery: string; invitation: string };
}

/**
 * Erro de caso de uso, traduzido pelo adaptador HTTP em Problem Details. `status` segue a API
 * (400 validação, 401 credencial, 403 permissão, 404 inexistente, 409 conflito, 422 regra, 429).
 */
export class IdentityError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string,
    readonly retryAfter?: Instant,
  ) {
    super(message);
  }
}

/** Mesma resposta para e-mail inexistente e senha errada (RN-AUTH-002). */
export const invalidCredentials = () =>
  new IdentityError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Contextos de cifra: um valor copiado para outra coluna não decifra. */
export const CTX = {
  email: 'user.email',
  name: 'user.name',
  taxId: 'user.tax_id',
  phone: 'mfa_factor.phone',
  totp: 'mfa_factor.secret',
  signingKey: 'signing_key.private',
} as const;

/** Quem está agindo numa rota autenticada (vem do access token, validado pelo service-kit). */
export interface Caller {
  userId: string;
  sessionId: string;
  realm: Realm;
  roles: readonly string[];
  ip?: string;
  userAgent?: string;
}

export async function activeSession(
  tx: IdentityTx,
  caller: Caller,
  now: Instant,
): Promise<SessionRow> {
  const session = await tx.session(caller.sessionId);
  if (
    !session ||
    session.userId !== caller.userId ||
    session.revokedAt ||
    !now.isBefore(session.expiresAt)
  ) {
    throw new IdentityError(401, 'SESSION_REVOKED', 'Sessão encerrada. Entre de novo.');
  }
  return session;
}

export async function requireUser(tx: IdentityTx, id: string): Promise<UserRow> {
  const user = await tx.userById(id);
  if (!user) throw new IdentityError(404, 'NOT_FOUND', 'Usuário inexistente.');
  return user;
}

export const channelOf = (realm: Realm, clientChannel: Channel | null): Channel =>
  realm === 'backoffice' ? 'BACKOFFICE' : (clientChannel ?? 'WEB');
