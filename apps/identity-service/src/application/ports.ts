import type { Instant } from '@broker/domain-kernel';
import type {
  Channel,
  LoginThrottle,
  Realm,
  SignatureScope,
  SignatureState,
} from '../domain/policies.js';

// ------------------------------------------------------------------ registros

export interface UserRow {
  id: string;
  realm: Realm;
  emailHash: string;
  emailEnc: string;
  nameEnc: string | null;
  taxIdEnc: string | null;
  status: 'PENDING' | 'ACTIVE' | 'DISABLED';
  customerId: string | null;
  accountId: string | null;
  desktopIdleMs: number | null;
  createdAt: Instant;
}

export type FactorType = 'TOTP' | 'WEBAUTHN' | 'SMS';

export interface FactorRow {
  id: string;
  userId: string;
  type: FactorType;
  status: 'PENDING' | 'ACTIVE' | 'REMOVED';
  secretEnc: string | null;
  phoneEnc: string | null;
  credentialId: string | null;
  publicKey: string | null;
  signCount: number | null;
  transports: string[] | null;
  lastUsedStep: number | null;
  createdAt: Instant;
  activatedAt: Instant | null;
}

export interface DeviceRow {
  id: string;
  userId: string;
  clientDevice: string;
  channel: Channel;
  userAgent: string | null;
  firstSeenAt: Instant;
  lastSeenAt: Instant;
}

export interface SessionRow {
  id: string;
  userId: string;
  realm: Realm;
  clientId: string;
  deviceId: string;
  channel: Channel;
  scope: string;
  amr: string[];
  mfaAt: Instant | null;
  biometric: boolean;
  createdAt: Instant;
  lastActivityAt: Instant;
  expiresAt: Instant;
  revokedAt: Instant | null;
  revokeReason: string | null;
  stepUpChallenge: string | null;
}

export interface RefreshRow {
  id: string;
  sessionId: string;
  tokenHash: string;
  issuedAt: Instant;
  expiresAt: Instant;
  rotatedAt: Instant | null;
}

export interface ClientRow {
  clientId: string;
  realm: Realm | 'services';
  type: 'PUBLIC' | 'CONFIDENTIAL';
  channel: Channel | null;
  secretHash: string | null;
  redirectUris: string[];
  allowedScopes: string[];
}

export interface LoginTransactionRow {
  idHash: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  clientDevice: string;
  biometric: boolean;
  webauthnChallenge: string | null;
  expiresAt: Instant;
  consumedAt: Instant | null;
}

export interface AuthCodeRow {
  codeHash: string;
  sessionId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: Instant;
  usedAt: Instant | null;
}

export interface SignatureRow extends SignatureState {
  userId: string;
  secretHash: string;
  changedAt: Instant;
}

export interface OneTimeTokenRow {
  tokenHash: string;
  purpose: 'RECOVERY' | 'INVITATION';
  userId: string;
  otpHash: string | null;
  otpAttempts: number;
  expiresAt: Instant;
  usedAt: Instant | null;
}

/** Eventos publicados pela outbox (contratos `identity.*`). */
export type IdentityEvent =
  | {
      type: 'identity.user_registered';
      payload: { userId: string; realm: Realm; emailHash: string; registeredAt: string };
    }
  | {
      type: 'identity.login_succeeded';
      payload: {
        userId: string;
        sessionId: string;
        deviceId: string;
        channel: string;
        ipHash?: string;
        newDevice: boolean;
      };
    }
  | {
      type: 'identity.login_failed';
      payload: { emailHash: string; reason: string; ipHash?: string; attemptCount: number };
    }
  | {
      type: 'identity.new_device_detected';
      payload: { userId: string; deviceId: string; channel: string };
    }
  | {
      type:
        'identity.password_changed' | 'identity.trading_signature_changed' | 'identity.mfa_enabled';
      payload: { userId: string; at: string };
    }
  | {
      type: 'identity.session_revoked';
      payload: { userId: string; sessionId: string; reason: string };
    };

// ------------------------------------------------------------------ banco

/** Unidade de trabalho: uma transação do banco do identity. */
export interface IdentityTx {
  userById(id: string, opts?: { forUpdate?: boolean }): Promise<UserRow | null>;
  userByEmail(realm: Realm, emailHash: string): Promise<UserRow | null>;
  insertUser(u: UserRow): Promise<boolean>;
  updateUser(
    id: string,
    patch: Partial<Pick<UserRow, 'status' | 'customerId' | 'accountId' | 'desktopIdleMs'>>,
  ): Promise<void>;
  usersByCustomer(customerId: string): Promise<UserRow[]>;
  usersByAccount(accountId: string): Promise<UserRow[]>;
  linkCustomerAccount(customerId: string, accountId: string): Promise<void>;
  accountsOfCustomer(customerId: string): Promise<string[]>;

  passwordHash(userId: string): Promise<string | null>;
  setPassword(userId: string, hash: string, at: Instant): Promise<void>;

  throttle(realm: Realm, emailHash: string): Promise<LoginThrottle>;
  saveThrottle(realm: Realm, emailHash: string, t: LoginThrottle): Promise<void>;
  insertLoginAttempt(a: {
    id: string;
    realm: Realm;
    emailHash: string;
    userId: string | null;
    success: boolean;
    reason: string | null;
    ipHash: string | null;
    at: Instant;
  }): Promise<void>;

  factors(userId: string, opts?: { includePending?: boolean }): Promise<FactorRow[]>;
  factorById(id: string): Promise<FactorRow | null>;
  factorByCredentialId(credentialId: string): Promise<FactorRow | null>;
  insertFactor(f: FactorRow): Promise<void>;
  updateFactor(
    id: string,
    patch: Partial<
      Pick<
        FactorRow,
        | 'status'
        | 'signCount'
        | 'lastUsedStep'
        | 'activatedAt'
        | 'secretEnc'
        | 'credentialId'
        | 'publicKey'
        | 'transports'
      >
    >,
  ): Promise<void>;

  signature(userId: string): Promise<SignatureRow | null>;
  saveSignature(s: SignatureRow): Promise<void>;

  device(userId: string, clientDevice: string): Promise<DeviceRow | null>;
  insertDevice(d: DeviceRow): Promise<void>;
  touchDevice(id: string, at: Instant): Promise<void>;
  devices(userId: string): Promise<DeviceRow[]>;

  session(id: string, opts?: { forUpdate?: boolean }): Promise<SessionRow | null>;
  activeSessions(userId: string, now: Instant): Promise<SessionRow[]>;
  insertSession(s: SessionRow): Promise<void>;
  touchSession(id: string, at: Instant): Promise<void>;
  recordMfa(id: string, amr: string[], at: Instant): Promise<void>;
  setStepUpChallenge(id: string, challenge: string | null): Promise<void>;
  revokeSession(id: string, reason: string, at: Instant): Promise<boolean>;

  refreshByHash(hash: string): Promise<RefreshRow | null>;
  insertRefresh(r: RefreshRow): Promise<void>;
  markRotated(id: string, at: Instant): Promise<boolean>;

  client(clientId: string): Promise<ClientRow | null>;
  insertClient(c: ClientRow): Promise<void>;

  insertLoginTransaction(t: LoginTransactionRow): Promise<void>;
  loginTransaction(
    idHash: string,
    opts?: { forUpdate?: boolean },
  ): Promise<LoginTransactionRow | null>;
  setWebauthnChallenge(idHash: string, challenge: string): Promise<void>;
  consumeLoginTransaction(idHash: string, at: Instant): Promise<boolean>;

  insertAuthCode(c: AuthCodeRow): Promise<void>;
  authCode(codeHash: string, opts?: { forUpdate?: boolean }): Promise<AuthCodeRow | null>;
  useAuthCode(codeHash: string, at: Instant): Promise<boolean>;

  insertSignatureToken(t: {
    jti: string;
    userId: string;
    sessionId: string;
    scope: SignatureScope;
    expiresAt: Instant;
  }): Promise<void>;
  revokeSignatureTokens(
    filter: { userId: string } | { sessionId: string },
    at: Instant,
  ): Promise<{ jti: string; expiresAt: Instant }[]>;

  insertOneTimeToken(t: OneTimeTokenRow): Promise<void>;
  oneTimeToken(hash: string, opts?: { forUpdate?: boolean }): Promise<OneTimeTokenRow | null>;
  updateOneTimeToken(
    hash: string,
    patch: Partial<Pick<OneTimeTokenRow, 'otpHash' | 'otpAttempts' | 'usedAt'>>,
  ): Promise<void>;

  roles(userId: string): Promise<string[]>;
  setRoles(userId: string, roles: readonly string[]): Promise<void>;

  publish(event: IdentityEvent, partitionKey: string): Promise<void>;
}

export interface IdentityStore {
  transaction<T>(fn: (tx: IdentityTx) => Promise<T>): Promise<T>;
}

// ------------------------------------------------------------------ segredos e criptografia

/** Hash lento com sal para senha, assinatura eletrônica e segredos de cliente (argon2id). */
export interface SecretHasher {
  hash(secret: string): Promise<string>;
  verify(hash: string, secret: string): Promise<boolean>;
  /** Gasta o mesmo tempo de uma verificação: login com e-mail inexistente (RN-AUTH-002). */
  burn(): Promise<void>;
}

/** Cifra de campo (AES-GCM com contexto) e HMAC de busca (RN-DB-031). */
export interface FieldProtection {
  seal(value: string, context: string): string;
  open(stored: string, context: string): string;
  /** HMAC do e-mail normalizado, para busca e para os eventos. */
  emailHash(email: string): string;
  /** HMAC curto do IP (os eventos levam o hash, não o IP). */
  ipHash(ip: string): string;
}

/** Valores aleatórios opacos (refresh, códigos, links) e o SHA-256 com que são guardados. */
export interface Randomness {
  token(): string;
  digits(n: number): string;
  sha256(value: string): string;
}

// ------------------------------------------------------------------ tokens

export interface AccessClaims {
  sub: string;
  realm: Realm | 'services';
  account_id?: string;
  roles: string[];
  scope: string;
  session_id?: string;
  amr: string[];
  /** Instante (s) do último MFA, para o step-up (RN-AUTHZ-003). */
  mfa_time?: number;
  client_id?: string;
}

export interface TokenSigner {
  /** Access token ES256 de 10 min com `exp`, `iat` e `jti` (Autenticação §4). */
  accessToken(
    claims: AccessClaims,
    now: Instant,
    ttlMs: number,
  ): Promise<{ token: string; jti: string }>;
  signatureToken(
    claims: { sub: string; session_id: string; sig_scope: SignatureScope; jti: string },
    now: Instant,
    ttlMs: number,
  ): Promise<string>;
  /** Chaves públicas publicadas (a ativa e as aposentadas ainda válidas). */
  jwks(): Promise<{ keys: object[] }>;
  rotate(now: Instant): Promise<string>;
}

/**
 * Lista de revogação no Valkey, lida pelo gateway e pelos serviços: uma sessão revogada derruba os
 * access tokens dela antes de expirarem; as assinaturas também.
 */
export interface RevocationList {
  revokeSession(sessionId: string, ttlMs: number): Promise<void>;
  revokeSignature(jti: string, ttlMs: number): Promise<void>;
}

// ------------------------------------------------------------------ fatores e mensagens

export interface TotpPort {
  newSecret(): string;
  uri(secret: string, label: string): string;
  /** Passo de tempo (30 s) do código aceito, ou `null`; códigos de passos já usados são recusados. */
  verify(secret: string, code: string, now: Instant, lastUsedStep: number | null): number | null;
  /** Código atual (testes e simulação). */
  generate(secret: string, now: Instant): string;
}

export interface WebAuthnPort {
  registrationOptions(
    user: { id: string; name: string },
    exclude: string[],
  ): Promise<{ options: object; challenge: string }>;
  verifyRegistration(
    response: unknown,
    challenge: string,
  ): Promise<{
    credentialId: string;
    publicKey: string;
    signCount: number;
    transports: string[];
  } | null>;
  authenticationOptions(
    allow: { credentialId: string; transports: string[] }[],
  ): Promise<{ options: object; challenge: string }>;
  verifyAuthentication(
    response: unknown,
    challenge: string,
    credential: { credentialId: string; publicKey: string; signCount: number },
  ): Promise<{ signCount: number } | null>;
}

/** E-mail transacional de segurança (SMTP → Mailpit) e SMS (message-sink). */
export interface Messenger {
  email(to: string, subject: string, text: string): Promise<void>;
  sms(to: string, text: string): Promise<void>;
}
