import { IdentityLoginFailedV1 } from '@broker/contracts/events/identity.login_failed/v1';
import { IdentityLoginSucceededV1 } from '@broker/contracts/events/identity.login_succeeded/v1';
import { IdentityMfaEnabledV1 } from '@broker/contracts/events/identity.mfa_enabled/v1';
import { IdentityNewDeviceDetectedV1 } from '@broker/contracts/events/identity.new_device_detected/v1';
import { IdentityPasswordChangedV1 } from '@broker/contracts/events/identity.password_changed/v1';
import { IdentitySessionRevokedV1 } from '@broker/contracts/events/identity.session_revoked/v1';
import { IdentityTradingSignatureChangedV1 } from '@broker/contracts/events/identity.trading_signature_changed/v1';
import { IdentityUserRegisteredV1 } from '@broker/contracts/events/identity.user_registered/v1';
import { Instant } from '@broker/domain-kernel';
import type { EventDefinition, EventPublisher } from '@broker/messaging';
import { inTransaction } from '@broker/persistence';
import { sql, type Kysely } from 'kysely';
import type {
  AuthCodeRow,
  ClientRow,
  DeviceRow,
  FactorRow,
  IdentityStore,
  IdentityTx,
  LoginTransactionRow,
  OneTimeTokenRow,
  RefreshRow,
  SessionRow,
  SignatureRow,
  UserRow,
} from '../application/ports.js';
import type { Channel, LoginThrottle, Realm } from '../domain/policies.js';

type Row = Record<string, unknown>;

const inst = (v: unknown): Instant => Instant.ofEpochMillis((v as Date).getTime());
const instOrNull = (v: unknown): Instant | null => (v ? inst(v) : null);
const ts = (i: Instant | null | undefined) => (i ? i.toString() : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const forUpdate = (opts?: { forUpdate?: boolean }) => (opts?.forUpdate ? sql` FOR UPDATE` : sql``);

const toUser = (r: Row): UserRow => ({
  id: r['id'] as string,
  realm: r['realm'] as Realm,
  emailHash: r['email_hash'] as string,
  emailEnc: r['email_enc'] as string,
  nameEnc: (r['name_enc'] as string | null) ?? null,
  taxIdEnc: (r['tax_id_enc'] as string | null) ?? null,
  status: r['status'] as UserRow['status'],
  customerId: (r['customer_id'] as string | null) ?? null,
  accountId: (r['account_id'] as string | null) ?? null,
  desktopIdleMs: num(r['desktop_idle_ms']),
  createdAt: inst(r['created_at']),
});

const toFactor = (r: Row): FactorRow => ({
  id: r['id'] as string,
  userId: r['user_id'] as string,
  type: r['type'] as FactorRow['type'],
  status: r['status'] as FactorRow['status'],
  secretEnc: (r['secret_enc'] as string | null) ?? null,
  phoneEnc: (r['phone_enc'] as string | null) ?? null,
  credentialId: (r['credential_id'] as string | null) ?? null,
  publicKey: (r['public_key'] as string | null) ?? null,
  signCount: num(r['sign_count']),
  transports: (r['transports'] as string[] | null) ?? null,
  lastUsedStep: num(r['last_used_step']),
  createdAt: inst(r['created_at']),
  activatedAt: instOrNull(r['activated_at']),
});

const toDevice = (r: Row): DeviceRow => ({
  id: r['id'] as string,
  userId: r['user_id'] as string,
  clientDevice: r['client_device'] as string,
  channel: r['channel'] as Channel,
  userAgent: (r['user_agent'] as string | null) ?? null,
  firstSeenAt: inst(r['first_seen_at']),
  lastSeenAt: inst(r['last_seen_at']),
});

const toSession = (r: Row): SessionRow => ({
  id: r['id'] as string,
  userId: r['user_id'] as string,
  realm: r['realm'] as Realm,
  clientId: r['client_id'] as string,
  deviceId: r['device_id'] as string,
  channel: r['channel'] as Channel,
  scope: r['scope'] as string,
  amr: r['amr'] as string[],
  mfaAt: instOrNull(r['mfa_at']),
  biometric: r['biometric'] as boolean,
  createdAt: inst(r['created_at']),
  lastActivityAt: inst(r['last_activity_at']),
  expiresAt: inst(r['expires_at']),
  revokedAt: instOrNull(r['revoked_at']),
  revokeReason: (r['revoke_reason'] as string | null) ?? null,
  stepUpChallenge: (r['stepup_challenge'] as string | null) ?? null,
});

const toClient = (r: Row): ClientRow => ({
  clientId: r['client_id'] as string,
  realm: r['realm'] as ClientRow['realm'],
  type: r['type'] as ClientRow['type'],
  channel: (r['channel'] as Channel | null) ?? null,
  secretHash: (r['secret_hash'] as string | null) ?? null,
  redirectUris: r['redirect_uris'] as string[],
  allowedScopes: r['allowed_scopes'] as string[],
});

const toOneTime = (r: Row): OneTimeTokenRow => ({
  tokenHash: r['token_hash'] as string,
  purpose: r['purpose'] as OneTimeTokenRow['purpose'],
  userId: r['user_id'] as string,
  otpHash: (r['otp_hash'] as string | null) ?? null,
  otpAttempts: Number(r['otp_attempts']),
  expiresAt: inst(r['expires_at']),
  usedAt: instOrNull(r['used_at']),
});

const EVENTS: Record<string, EventDefinition> = {
  'identity.user_registered': IdentityUserRegisteredV1,
  'identity.login_succeeded': IdentityLoginSucceededV1,
  'identity.login_failed': IdentityLoginFailedV1,
  'identity.new_device_detected': IdentityNewDeviceDetectedV1,
  'identity.password_changed': IdentityPasswordChangedV1,
  'identity.trading_signature_changed': IdentityTradingSignatureChangedV1,
  'identity.mfa_enabled': IdentityMfaEnabledV1,
  'identity.session_revoked': IdentitySessionRevokedV1,
};

const ACTOR = { type: 'SYSTEM' as const, id: 'identity-service' };

/** Adaptador do banco do identity; os eventos vão para a outbox na mesma transação (ADR-0008). */
export class PostgresIdentityStore implements IdentityStore {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly publisher: EventPublisher,
  ) {}

  transaction<T>(fn: (tx: IdentityTx) => Promise<T>): Promise<T> {
    return inTransaction(this.db, (trx) => fn(this.tx(trx)));
  }

  /** Unidade de trabalho sobre uma transação já aberta (ex.: a do consumidor, com a inbox). */
  tx(trx: Kysely<unknown>): IdentityTx {
    const publisher = this.publisher;
    const one = async (q: ReturnType<typeof sql<Row>>) => (await q.execute(trx)).rows[0];
    const all = async (q: ReturnType<typeof sql<Row>>) => (await q.execute(trx)).rows;
    return {
      // ------------------------------------------------------------ usuário
      async userById(id, opts) {
        const r = await one(sql<Row>`SELECT * FROM "user" WHERE id = ${id}${forUpdate(opts)}`);
        return r ? toUser(r) : null;
      },
      async userByEmail(realm, emailHash) {
        const r = await one(
          sql<Row>`SELECT * FROM "user" WHERE realm = ${realm} AND email_hash = ${emailHash}`,
        );
        return r ? toUser(r) : null;
      },
      async insertUser(u) {
        const { rows } = await sql`
          INSERT INTO "user" (id, realm, email_hash, email_enc, name_enc, tax_id_enc, status, customer_id,
            account_id, desktop_idle_ms, created_at)
          VALUES (${u.id}, ${u.realm}, ${u.emailHash}, ${u.emailEnc}, ${u.nameEnc}, ${u.taxIdEnc}, ${u.status},
            ${u.customerId}, ${u.accountId}, ${u.desktopIdleMs}, ${u.createdAt.toString()})
          ON CONFLICT (realm, email_hash) DO NOTHING RETURNING id`.execute(trx);
        return rows.length > 0;
      },
      async updateUser(id, patch) {
        const sets = [];
        if (patch.status !== undefined) sets.push(sql`status = ${patch.status}`);
        if (patch.customerId !== undefined) sets.push(sql`customer_id = ${patch.customerId}`);
        if (patch.accountId !== undefined) sets.push(sql`account_id = ${patch.accountId}`);
        if (patch.desktopIdleMs !== undefined)
          sets.push(sql`desktop_idle_ms = ${patch.desktopIdleMs}`);
        if (sets.length === 0) return;
        await sql`UPDATE "user" SET ${sql.join(sets)} WHERE id = ${id}`.execute(trx);
      },
      async usersByCustomer(customerId) {
        return (await all(sql<Row>`SELECT * FROM "user" WHERE customer_id = ${customerId}`)).map(
          toUser,
        );
      },
      async usersByAccount(accountId) {
        return (await all(sql<Row>`SELECT * FROM "user" WHERE account_id = ${accountId}`)).map(
          toUser,
        );
      },
      async linkCustomerAccount(customerId, accountId) {
        await sql`INSERT INTO customer_account (customer_id, account_id) VALUES (${customerId}, ${accountId}) ON CONFLICT DO NOTHING`.execute(
          trx,
        );
      },
      async accountsOfCustomer(customerId) {
        return (
          await all(
            sql<Row>`SELECT account_id FROM customer_account WHERE customer_id = ${customerId} ORDER BY account_id`,
          )
        ).map((r) => r['account_id'] as string);
      },

      // ------------------------------------------------------------ senha e bloqueio
      async passwordHash(userId) {
        return (
          ((await one(sql<Row>`SELECT password_hash FROM credential WHERE user_id = ${userId}`))?.[
            'password_hash'
          ] as string) ?? null
        );
      },
      async setPassword(userId, hash, at) {
        await sql`
          INSERT INTO credential (user_id, password_hash, changed_at) VALUES (${userId}, ${hash}, ${at.toString()})
          ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, changed_at = EXCLUDED.changed_at`.execute(
          trx,
        );
      },
      async throttle(realm, emailHash): Promise<LoginThrottle> {
        // Cria a linha se preciso e trava: tentativas simultâneas do mesmo e-mail entram em fila.
        await sql`INSERT INTO login_throttle (realm, email_hash) VALUES (${realm}, ${emailHash}) ON CONFLICT DO NOTHING`.execute(
          trx,
        );
        const r = (await one(
          sql<Row>`SELECT * FROM login_throttle WHERE realm = ${realm} AND email_hash = ${emailHash} FOR UPDATE`,
        ))!;
        return {
          failures: Number(r['failures']),
          lastFailureAt: instOrNull(r['last_failure_at']),
          lockedUntil: instOrNull(r['locked_until']),
        };
      },
      async saveThrottle(realm, emailHash, t) {
        await sql`
          INSERT INTO login_throttle (realm, email_hash, failures, last_failure_at, locked_until)
          VALUES (${realm}, ${emailHash}, ${t.failures}, ${ts(t.lastFailureAt)}, ${ts(t.lockedUntil)})
          ON CONFLICT (realm, email_hash) DO UPDATE SET failures = EXCLUDED.failures,
            last_failure_at = EXCLUDED.last_failure_at, locked_until = EXCLUDED.locked_until`.execute(
          trx,
        );
      },
      async insertLoginAttempt(a) {
        await sql`
          INSERT INTO login_attempt (id, realm, email_hash, user_id, success, reason, ip_hash, at)
          VALUES (${a.id}, ${a.realm}, ${a.emailHash}, ${a.userId}, ${a.success}, ${a.reason}, ${a.ipHash}, ${a.at.toString()})`.execute(
          trx,
        );
      },

      // ------------------------------------------------------------ fatores
      async factors(userId, opts) {
        const statuses = opts?.includePending ? ['ACTIVE', 'PENDING'] : ['ACTIVE'];
        return (
          await all(
            sql<Row>`SELECT * FROM mfa_factor WHERE user_id = ${userId} AND status = ANY(${statuses}) ORDER BY created_at`,
          )
        ).map(toFactor);
      },
      async factorById(id) {
        const r = await one(sql<Row>`SELECT * FROM mfa_factor WHERE id = ${id}`);
        return r ? toFactor(r) : null;
      },
      async factorByCredentialId(credentialId) {
        const r = await one(
          sql<Row>`SELECT * FROM mfa_factor WHERE credential_id = ${credentialId}`,
        );
        return r ? toFactor(r) : null;
      },
      async insertFactor(f) {
        await sql`
          INSERT INTO mfa_factor (id, user_id, type, status, secret_enc, phone_enc, credential_id, public_key,
            sign_count, transports, last_used_step, created_at, activated_at)
          VALUES (${f.id}, ${f.userId}, ${f.type}, ${f.status}, ${f.secretEnc}, ${f.phoneEnc}, ${f.credentialId},
            ${f.publicKey}, ${f.signCount}, ${f.transports}, ${f.lastUsedStep}, ${f.createdAt.toString()}, ${ts(f.activatedAt)})`.execute(
          trx,
        );
      },
      async updateFactor(id, p) {
        const sets = [];
        if (p.status !== undefined) sets.push(sql`status = ${p.status}`);
        if (p.signCount !== undefined) sets.push(sql`sign_count = ${p.signCount}`);
        if (p.lastUsedStep !== undefined) sets.push(sql`last_used_step = ${p.lastUsedStep}`);
        if (p.activatedAt !== undefined) sets.push(sql`activated_at = ${ts(p.activatedAt)}`);
        if (p.secretEnc !== undefined) sets.push(sql`secret_enc = ${p.secretEnc}`);
        if (p.credentialId !== undefined) sets.push(sql`credential_id = ${p.credentialId}`);
        if (p.publicKey !== undefined) sets.push(sql`public_key = ${p.publicKey}`);
        if (p.transports !== undefined) sets.push(sql`transports = ${p.transports}`);
        if (sets.length === 0) return;
        await sql`UPDATE mfa_factor SET ${sql.join(sets)} WHERE id = ${id}`.execute(trx);
      },

      // ------------------------------------------------------------ assinatura eletrônica
      async signature(userId) {
        const r = await one(
          sql<Row>`SELECT * FROM trading_signature WHERE user_id = ${userId} FOR UPDATE`,
        );
        if (!r) return null;
        return {
          userId,
          secretHash: r['secret_hash'] as string,
          failures: Number(r['failures']),
          lockedUntil: instOrNull(r['locked_until']),
          resetRequired: r['reset_required'] as boolean,
          blockedUntil: instOrNull(r['blocked_until']),
          changedAt: inst(r['changed_at']),
        } satisfies SignatureRow;
      },
      async saveSignature(s) {
        await sql`
          INSERT INTO trading_signature (user_id, secret_hash, failures, locked_until, reset_required, blocked_until, changed_at)
          VALUES (${s.userId}, ${s.secretHash}, ${s.failures}, ${ts(s.lockedUntil)}, ${s.resetRequired}, ${ts(s.blockedUntil)}, ${s.changedAt.toString()})
          ON CONFLICT (user_id) DO UPDATE SET secret_hash = EXCLUDED.secret_hash, failures = EXCLUDED.failures,
            locked_until = EXCLUDED.locked_until, reset_required = EXCLUDED.reset_required,
            blocked_until = EXCLUDED.blocked_until, changed_at = EXCLUDED.changed_at`.execute(trx);
      },

      // ------------------------------------------------------------ dispositivos e sessões
      async device(userId, clientDevice) {
        const r = await one(
          sql<Row>`SELECT * FROM device WHERE user_id = ${userId} AND client_device = ${clientDevice}`,
        );
        return r ? toDevice(r) : null;
      },
      async insertDevice(d) {
        await sql`
          INSERT INTO device (id, user_id, client_device, channel, user_agent, first_seen_at, last_seen_at)
          VALUES (${d.id}, ${d.userId}, ${d.clientDevice}, ${d.channel}, ${d.userAgent}, ${d.firstSeenAt.toString()}, ${d.lastSeenAt.toString()})`.execute(
          trx,
        );
      },
      async touchDevice(id, at) {
        await sql`UPDATE device SET last_seen_at = ${at.toString()} WHERE id = ${id}`.execute(trx);
      },
      async devices(userId) {
        return (
          await all(sql<Row>`SELECT * FROM device WHERE user_id = ${userId} ORDER BY first_seen_at`)
        ).map(toDevice);
      },
      async session(id, opts) {
        const r = await one(sql<Row>`SELECT * FROM session WHERE id = ${id}${forUpdate(opts)}`);
        return r ? toSession(r) : null;
      },
      async activeSessions(userId, now) {
        return (
          await all(
            sql<Row>`SELECT * FROM session WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > ${now.toString()} ORDER BY created_at`,
          )
        ).map(toSession);
      },
      async insertSession(s) {
        await sql`
          INSERT INTO session (id, user_id, realm, client_id, device_id, channel, scope, amr, mfa_at, biometric,
            created_at, last_activity_at, expires_at)
          VALUES (${s.id}, ${s.userId}, ${s.realm}, ${s.clientId}, ${s.deviceId}, ${s.channel}, ${s.scope}, ${s.amr},
            ${ts(s.mfaAt)}, ${s.biometric}, ${s.createdAt.toString()}, ${s.lastActivityAt.toString()}, ${s.expiresAt.toString()})`.execute(
          trx,
        );
      },
      async touchSession(id, at) {
        await sql`UPDATE session SET last_activity_at = ${at.toString()} WHERE id = ${id}`.execute(
          trx,
        );
      },
      async recordMfa(id, amr, at) {
        await sql`
          UPDATE session SET mfa_at = ${at.toString()},
            amr = ARRAY(SELECT DISTINCT unnest(amr || ${amr}::text[]) ORDER BY 1)
          WHERE id = ${id}`.execute(trx);
      },
      async setStepUpChallenge(id, challenge) {
        await sql`UPDATE session SET stepup_challenge = ${challenge} WHERE id = ${id}`.execute(trx);
      },
      async revokeSession(id, reason, at) {
        const { rows } = await sql`
          UPDATE session SET revoked_at = ${at.toString()}, revoke_reason = ${reason}
          WHERE id = ${id} AND revoked_at IS NULL RETURNING id`.execute(trx);
        return rows.length > 0;
      },

      // ------------------------------------------------------------ refresh, clientes, login
      async refreshByHash(hash) {
        const r = await one(sql<Row>`SELECT * FROM refresh_token WHERE token_hash = ${hash}`);
        return r
          ? ({
              id: r['id'] as string,
              sessionId: r['session_id'] as string,
              tokenHash: r['token_hash'] as string,
              issuedAt: inst(r['issued_at']),
              expiresAt: inst(r['expires_at']),
              rotatedAt: instOrNull(r['rotated_at']),
            } satisfies RefreshRow)
          : null;
      },
      async insertRefresh(r) {
        await sql`
          INSERT INTO refresh_token (id, session_id, token_hash, issued_at, expires_at)
          VALUES (${r.id}, ${r.sessionId}, ${r.tokenHash}, ${r.issuedAt.toString()}, ${r.expiresAt.toString()})`.execute(
          trx,
        );
      },
      async markRotated(id, at) {
        // Condicional: dois usos simultâneos do mesmo refresh não rotacionam os dois.
        const { rows } = await sql`
          UPDATE refresh_token SET rotated_at = ${at.toString()} WHERE id = ${id} AND rotated_at IS NULL RETURNING id`.execute(
          trx,
        );
        return rows.length > 0;
      },
      async client(clientId) {
        const r = await one(sql<Row>`SELECT * FROM oauth_client WHERE client_id = ${clientId}`);
        return r ? toClient(r) : null;
      },
      async insertClient(c) {
        await sql`
          INSERT INTO oauth_client (client_id, realm, type, channel, secret_hash, redirect_uris, allowed_scopes)
          VALUES (${c.clientId}, ${c.realm}, ${c.type}, ${c.channel}, ${c.secretHash}, ${c.redirectUris}, ${c.allowedScopes})`.execute(
          trx,
        );
      },
      async insertLoginTransaction(t: LoginTransactionRow) {
        await sql`
          INSERT INTO login_transaction (id_hash, user_id, client_id, redirect_uri, code_challenge, scope, client_device,
            biometric, webauthn_challenge, expires_at)
          VALUES (${t.idHash}, ${t.userId}, ${t.clientId}, ${t.redirectUri}, ${t.codeChallenge}, ${t.scope}, ${t.clientDevice},
            ${t.biometric}, ${t.webauthnChallenge}, ${t.expiresAt.toString()})`.execute(trx);
      },
      async loginTransaction(idHash, opts) {
        const r = await one(
          sql<Row>`SELECT * FROM login_transaction WHERE id_hash = ${idHash}${forUpdate(opts)}`,
        );
        return r
          ? {
              idHash,
              userId: r['user_id'] as string,
              clientId: r['client_id'] as string,
              redirectUri: r['redirect_uri'] as string,
              codeChallenge: r['code_challenge'] as string,
              scope: r['scope'] as string,
              clientDevice: r['client_device'] as string,
              biometric: r['biometric'] as boolean,
              webauthnChallenge: (r['webauthn_challenge'] as string | null) ?? null,
              expiresAt: inst(r['expires_at']),
              consumedAt: instOrNull(r['consumed_at']),
            }
          : null;
      },
      async setWebauthnChallenge(idHash, challenge) {
        await sql`UPDATE login_transaction SET webauthn_challenge = ${challenge} WHERE id_hash = ${idHash}`.execute(
          trx,
        );
      },
      async consumeLoginTransaction(idHash, at) {
        const { rows } = await sql`
          UPDATE login_transaction SET consumed_at = ${at.toString()} WHERE id_hash = ${idHash} AND consumed_at IS NULL RETURNING id_hash`.execute(
          trx,
        );
        return rows.length > 0;
      },
      async insertAuthCode(c: AuthCodeRow) {
        await sql`
          INSERT INTO authorization_code (code_hash, session_id, client_id, redirect_uri, code_challenge, expires_at)
          VALUES (${c.codeHash}, ${c.sessionId}, ${c.clientId}, ${c.redirectUri}, ${c.codeChallenge}, ${c.expiresAt.toString()})`.execute(
          trx,
        );
      },
      async authCode(codeHash, opts) {
        const r = await one(
          sql<Row>`SELECT * FROM authorization_code WHERE code_hash = ${codeHash}${forUpdate(opts)}`,
        );
        return r
          ? {
              codeHash,
              sessionId: r['session_id'] as string,
              clientId: r['client_id'] as string,
              redirectUri: r['redirect_uri'] as string,
              codeChallenge: r['code_challenge'] as string,
              expiresAt: inst(r['expires_at']),
              usedAt: instOrNull(r['used_at']),
            }
          : null;
      },
      async useAuthCode(codeHash, at) {
        const { rows } = await sql`
          UPDATE authorization_code SET used_at = ${at.toString()} WHERE code_hash = ${codeHash} AND used_at IS NULL RETURNING code_hash`.execute(
          trx,
        );
        return rows.length > 0;
      },

      // ------------------------------------------------------------ assinatura, links e papéis
      async insertSignatureToken(t) {
        await sql`
          INSERT INTO signature_token (jti, user_id, session_id, scope, expires_at)
          VALUES (${t.jti}, ${t.userId}, ${t.sessionId}, ${t.scope}, ${t.expiresAt.toString()})`.execute(
          trx,
        );
      },
      async revokeSignatureTokens(filter, at) {
        const where =
          'userId' in filter
            ? sql`user_id = ${filter.userId}`
            : sql`session_id = ${filter.sessionId}`;
        const rows = await all(sql<Row>`
          UPDATE signature_token SET revoked_at = ${at.toString()}
          WHERE ${where} AND revoked_at IS NULL AND expires_at > ${at.toString()}
          RETURNING jti, expires_at`);
        return rows.map((r) => ({ jti: r['jti'] as string, expiresAt: inst(r['expires_at']) }));
      },
      async insertOneTimeToken(t) {
        await sql`
          INSERT INTO one_time_token (token_hash, purpose, user_id, otp_hash, otp_attempts, expires_at)
          VALUES (${t.tokenHash}, ${t.purpose}, ${t.userId}, ${t.otpHash}, ${t.otpAttempts}, ${t.expiresAt.toString()})`.execute(
          trx,
        );
      },
      async oneTimeToken(hash, opts) {
        const r = await one(
          sql<Row>`SELECT * FROM one_time_token WHERE token_hash = ${hash}${forUpdate(opts)}`,
        );
        return r ? toOneTime(r) : null;
      },
      async updateOneTimeToken(hash, p) {
        const sets = [];
        if (p.otpHash !== undefined) sets.push(sql`otp_hash = ${p.otpHash}`);
        if (p.otpAttempts !== undefined) sets.push(sql`otp_attempts = ${p.otpAttempts}`);
        if (p.usedAt !== undefined) sets.push(sql`used_at = ${ts(p.usedAt)}`);
        if (sets.length === 0) return;
        await sql`UPDATE one_time_token SET ${sql.join(sets)} WHERE token_hash = ${hash}`.execute(
          trx,
        );
      },
      async roles(userId) {
        return (
          await all(sql<Row>`SELECT role FROM user_role WHERE user_id = ${userId} ORDER BY role`)
        ).map((r) => r['role'] as string);
      },
      async setRoles(userId, roles) {
        await sql`DELETE FROM user_role WHERE user_id = ${userId}`.execute(trx);
        for (const role of roles) {
          await sql`INSERT INTO user_role (user_id, role) VALUES (${userId}, ${role})`.execute(trx);
        }
      },

      async publish(event, partitionKey) {
        const definition = EVENTS[event.type];
        if (!definition) throw new Error(`evento sem contrato: ${event.type}`);
        await publisher.publish(trx, definition, event.payload as never, {
          // identity.events é particionado pelo usuário (o login_failed, pelo hash do e-mail).
          partitionKey,
          aggregateType: 'user',
          aggregateId: partitionKey,
          actor: ACTOR,
        });
      },
    };
  }
}
