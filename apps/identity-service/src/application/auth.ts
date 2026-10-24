import type { Instant } from '@broker/domain-kernel';
import { pkceMatches } from '../domain/pkce.js';
import {
  ACCESS_TOKEN_TTL_MS,
  AUTH_CODE_TTL_MS,
  canRefresh,
  CUSTOMER_SCOPES,
  DESKTOP_IDLE_MAX_MS,
  loginBlockedUntil,
  MFA_CHALLENGE_TTL_MS,
  refreshTtlMs,
  registerLoginFailure,
  type Realm,
} from '../domain/policies.js';
import {
  activeSession,
  channelOf,
  CTX,
  IdentityError,
  invalidCredentials,
  normalizeEmail,
  requireUser,
  type Caller,
  type IdentityDeps,
} from './context.js';
import { invalidMfa, type Factors, type FactorProof } from './factors.js';
import type { AccessClaims, ClientRow, IdentityTx, SessionRow, UserRow } from './ports.js';

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_CUSTOMER_SCOPE =
  'profile:read profile:write portfolio:read orders:read orders:write funds:write market:read tax:read';

/** Pedido de autorização (Authorization Code + PKCE em fluxo nativo, RN-AUTH-010/011). */
export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope?: string;
  /** Identificador estável do dispositivo, gerado pelo app/BFF (base do "novo dispositivo"). */
  deviceId: string;
  /** Mobile com desbloqueio biométrico: refresh de 90 dias. */
  biometric?: boolean;
  ip?: string;
  userAgent?: string;
}

export type AuthorizeResult =
  | { status: 'AUTHORIZED'; code: string; redirectUri: string }
  | { status: 'MFA_REQUIRED'; mfaToken: string; methods: string[]; expiresAt: string };

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

const oauthError = (code: string, message: string, status = 400) =>
  new IdentityError(status, code, message);

/** Login, tokens e sessões (Autenticação §4, RN-AUTH-002, RN-AUTH-012/013). */
export class Auth {
  constructor(
    private readonly d: IdentityDeps,
    private readonly factors: Factors,
  ) {}

  // ---------------------------------------------------------------- login

  /** Primeira etapa: cliente, PKCE e senha, com atraso progressivo e bloqueio por e-mail. */
  async authorize(
    req: AuthorizeRequest & { email: string; password: string },
  ): Promise<AuthorizeResult> {
    const now = this.d.clock.now();
    const email = normalizeEmail(req.email);
    const client = await this.d.store.transaction((tx) => this.publicClient(tx, req));
    const realm = client.realm as Realm;
    const scope = this.scopeFor(realm, req.scope);
    const emailHash = this.d.fields.emailHash(email);
    const ipHash = req.ip ? this.d.fields.ipHash(req.ip) : undefined;

    type Outcome =
      | { ok: true; result: AuthorizeResult }
      | { ok: false; error: IdentityError; lockedUser?: UserRow };
    const outcome: Outcome = await this.d.store.transaction(async (tx) => {
      const throttle = await tx.throttle(realm, emailHash);
      const blocked = loginBlockedUntil(throttle, now);
      if (blocked) return { ok: false, error: lockedError(blocked) };

      const user = await tx.userByEmail(realm, emailHash);
      const stored = user?.status === 'ACTIVE' ? await tx.passwordHash(user.id) : null;
      // Sem usuário, gasta o mesmo tempo de uma verificação: a latência também não pode contar.
      const valid = stored
        ? await this.d.hasher.verify(stored, req.password)
        : (await this.d.hasher.burn(), false);
      if (!valid || !user) {
        const failure = registerLoginFailure(throttle, now);
        await tx.saveThrottle(realm, emailHash, failure.next);
        await this.logAttempt(
          tx,
          realm,
          emailHash,
          user?.id ?? null,
          false,
          failure.locked ? 'LOCKED' : 'INVALID_CREDENTIALS',
          ipHash,
          failure.attempt,
          now,
        );
        return {
          ok: false,
          error: invalidCredentials(),
          ...(failure.locked && user ? { lockedUser: user } : {}),
        };
      }

      const strong = await this.factors.strong(tx, user.id);
      // RN-BO-002: no backoffice, MFA forte sempre; no cliente, sempre que houver fator ativo.
      if (realm === 'backoffice' && strong.length === 0) {
        return {
          ok: false,
          error: new IdentityError(
            403,
            'MFA_ENROLLMENT_REQUIRED',
            'Conclua o convite ativando o autenticador.',
          ),
        };
      }
      if (strong.length > 0) {
        const mfaToken = this.d.random.token();
        const expiresAt = now.plusMillis(MFA_CHALLENGE_TTL_MS);
        await tx.insertLoginTransaction({
          idHash: this.d.random.sha256(mfaToken),
          userId: user.id,
          clientId: client.clientId,
          redirectUri: req.redirectUri,
          codeChallenge: req.codeChallenge,
          scope,
          clientDevice: req.deviceId,
          biometric: req.biometric ?? false,
          webauthnChallenge: null,
          expiresAt,
          consumedAt: null,
        });
        // A senha estava certa, mas o login só termina com o fator: o contador ainda não zera.
        return {
          ok: true,
          result: {
            status: 'MFA_REQUIRED',
            mfaToken,
            methods: [...new Set(strong.map((f) => f.type))],
            expiresAt: expiresAt.toString(),
          },
        };
      }
      await tx.saveThrottle(realm, emailHash, {
        failures: 0,
        lastFailureAt: null,
        lockedUntil: null,
      });
      const code = await this.completeLogin(tx, user, client, {
        redirectUri: req.redirectUri,
        codeChallenge: req.codeChallenge,
        scope,
        clientDevice: req.deviceId,
        biometric: req.biometric ?? false,
        amr: ['pwd'],
        mfaAt: null,
        ip: req.ip,
        userAgent: req.userAgent,
      });
      return { ok: true, result: { status: 'AUTHORIZED', code, redirectUri: req.redirectUri } };
    });

    if (outcome.ok) return outcome.result;
    if (outcome.lockedUser) await this.lockNotice(outcome.lockedUser);
    throw outcome.error;
  }

  /** Opções WebAuthn para a etapa de MFA do login. */
  async mfaWebauthnOptions(mfaToken: string): Promise<{ options: object }> {
    return this.d.store.transaction(async (tx) => {
      const t = await this.liveTransaction(tx, mfaToken);
      const { options, challenge } = await this.factors.webauthnAssertion(tx, t.userId);
      await tx.setWebauthnChallenge(t.idHash, challenge);
      return { options };
    });
  }

  /** Segunda etapa: o fator forte. Falhas contam no mesmo bloqueio da senha. */
  async authorizeMfa(
    mfaToken: string,
    proof: FactorProof,
    meta: { ip?: string; userAgent?: string },
  ): Promise<AuthorizeResult> {
    const now = this.d.clock.now();
    type Outcome =
      | { ok: true; result: AuthorizeResult }
      | { ok: false; error: IdentityError; lockedUser?: UserRow };
    const outcome: Outcome = await this.d.store.transaction(async (tx) => {
      const t = await this.liveTransaction(tx, mfaToken, true);
      const user = await requireUser(tx, t.userId);
      const throttle = await tx.throttle(user.realm, user.emailHash);
      const blocked = loginBlockedUntil(throttle, now);
      if (blocked) return { ok: false, error: lockedError(blocked) };
      let amr: string;
      try {
        amr = await this.factors.verify(tx, user.id, proof, t.webauthnChallenge);
      } catch (err) {
        if (!(err instanceof IdentityError) || err.code !== 'INVALID_MFA') throw err;
        const failure = registerLoginFailure(throttle, now);
        await tx.saveThrottle(user.realm, user.emailHash, failure.next);
        await this.logAttempt(
          tx,
          user.realm,
          user.emailHash,
          user.id,
          false,
          'INVALID_MFA',
          meta.ip ? this.d.fields.ipHash(meta.ip) : undefined,
          failure.attempt,
          now,
        );
        if (failure.locked) await tx.consumeLoginTransaction(t.idHash, now);
        return { ok: false, error: invalidMfa(), ...(failure.locked ? { lockedUser: user } : {}) };
      }
      await tx.consumeLoginTransaction(t.idHash, now);
      await tx.saveThrottle(user.realm, user.emailHash, {
        failures: 0,
        lastFailureAt: null,
        lockedUntil: null,
      });
      const client = (await tx.client(t.clientId))!;
      const code = await this.completeLogin(tx, user, client, {
        redirectUri: t.redirectUri,
        codeChallenge: t.codeChallenge,
        scope: t.scope,
        clientDevice: t.clientDevice,
        biometric: t.biometric,
        amr: ['pwd', amr, 'mfa'],
        mfaAt: now,
        ...meta,
      });
      return { ok: true, result: { status: 'AUTHORIZED', code, redirectUri: t.redirectUri } };
    });
    if (outcome.ok) return outcome.result;
    if (outcome.lockedUser) await this.lockNotice(outcome.lockedUser);
    throw outcome.error;
  }

  /** Cria a sessão (e o dispositivo, se novo) e um código de autorização de uso único. */
  private async completeLogin(
    tx: IdentityTx,
    user: UserRow,
    client: ClientRow,
    p: {
      redirectUri: string;
      codeChallenge: string;
      scope: string;
      clientDevice: string;
      biometric: boolean;
      amr: string[];
      mfaAt: Instant | null;
      ip?: string | undefined;
      userAgent?: string | undefined;
    },
  ): Promise<string> {
    const now = this.d.clock.now();
    const channel = channelOf(user.realm, client.channel);
    let device = await tx.device(user.id, p.clientDevice);
    const newDevice = !device;
    if (!device) {
      device = {
        id: this.d.newId(),
        userId: user.id,
        clientDevice: p.clientDevice,
        channel,
        userAgent: p.userAgent ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
      };
      await tx.insertDevice(device);
    } else {
      await tx.touchDevice(device.id, now);
    }
    const session: SessionRow = {
      id: this.d.newId(),
      userId: user.id,
      realm: user.realm,
      clientId: client.clientId,
      deviceId: device.id,
      channel,
      scope: p.scope,
      amr: p.amr,
      mfaAt: p.mfaAt,
      biometric: channel === 'MOBILE' && p.biometric,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: now.plusMillis(refreshTtlMs(channel, channel === 'MOBILE' && p.biometric)),
      revokedAt: null,
      revokeReason: null,
      stepUpChallenge: null,
    };
    await tx.insertSession(session);
    const code = this.d.random.token();
    await tx.insertAuthCode({
      codeHash: this.d.random.sha256(code),
      sessionId: session.id,
      clientId: client.clientId,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      expiresAt: now.plusMillis(AUTH_CODE_TTL_MS),
      usedAt: null,
    });
    await this.logAttempt(
      tx,
      user.realm,
      user.emailHash,
      user.id,
      true,
      null,
      p.ip ? this.d.fields.ipHash(p.ip) : undefined,
      0,
      now,
    );
    await tx.publish(
      {
        type: 'identity.login_succeeded',
        payload: {
          userId: user.id,
          sessionId: session.id,
          deviceId: device.id,
          channel,
          ...(p.ip ? { ipHash: this.d.fields.ipHash(p.ip) } : {}),
          newDevice,
        },
      },
      user.id,
    );
    // RN-AUTH-013: dispositivo nunca visto → notificação SECURITY_NEW_DEVICE. O primeiro login
    // da conta não é "novo dispositivo".
    if (newDevice && (await tx.devices(user.id)).length > 1) {
      await tx.publish(
        {
          type: 'identity.new_device_detected',
          payload: { userId: user.id, deviceId: device.id, channel },
        },
        user.id,
      );
    }
    return code;
  }

  // ---------------------------------------------------------------- endpoint de token

  /** `authorization_code`: troca o código pelo par de tokens, conferindo o `code_verifier`. */
  async exchangeCode(p: {
    code: string;
    codeVerifier: string;
    clientId: string;
    redirectUri: string;
  }): Promise<TokenResponse> {
    const now = this.d.clock.now();
    const result = await this.d.store.transaction(async (tx) => {
      const hash = this.d.random.sha256(p.code);
      const code = await tx.authCode(hash, { forUpdate: true });
      if (!code) return { error: oauthError('invalid_grant', 'Código inválido.') };
      if (code.usedAt) {
        // Código repetido: alguém interceptou. A sessão criada com ele cai (RFC 6749 §4.1.2).
        await this.revoke(tx, code.sessionId, 'CODE_REUSE', now);
        return { error: oauthError('invalid_grant', 'Código já usado.') };
      }
      if (
        !now.isBefore(code.expiresAt) ||
        code.clientId !== p.clientId ||
        code.redirectUri !== p.redirectUri
      ) {
        return { error: oauthError('invalid_grant', 'Código inválido ou expirado.') };
      }
      if (!pkceMatches(p.codeVerifier, code.codeChallenge)) {
        return {
          error: oauthError('invalid_grant', 'code_verifier não confere com o code_challenge.'),
        };
      }
      await tx.useAuthCode(hash, now);
      const session = (await tx.session(code.sessionId, { forUpdate: true }))!;
      if (session.revokedAt) return { error: oauthError('invalid_grant', 'Sessão encerrada.') };
      return { tokens: await this.issue(tx, session, now, true) };
    });
    if ('error' in result) throw result.error;
    return result.tokens;
  }

  /**
   * `refresh_token`: rotação a cada uso. Um refresh já rotacionado é reuso: a família inteira (a
   * sessão) é revogada (Autenticação §4). A inatividade por canal também encerra a sessão.
   */
  async refresh(p: { refreshToken: string; clientId: string }): Promise<TokenResponse> {
    const now = this.d.clock.now();
    const result = await this.d.store.transaction(async (tx) => {
      const row = await tx.refreshByHash(this.d.random.sha256(p.refreshToken));
      if (!row) return { error: oauthError('invalid_grant', 'Refresh token inválido.') };
      const session = (await tx.session(row.sessionId, { forUpdate: true }))!;
      if (session.clientId !== p.clientId)
        return { error: oauthError('invalid_grant', 'Refresh token de outro cliente.') };
      if (row.rotatedAt || !(await tx.markRotated(row.id, now))) {
        await this.revoke(tx, session.id, 'REFRESH_REUSE', now);
        return {
          error: oauthError('invalid_grant', 'Refresh token reutilizado: a sessão foi encerrada.'),
        };
      }
      if (!now.isBefore(row.expiresAt))
        return { error: oauthError('invalid_grant', 'Refresh token expirado.') };
      const user = await requireUser(tx, session.userId);
      const refusal = canRefresh({ ...session, desktopIdleMs: user.desktopIdleMs }, now);
      if (refusal) {
        if (refusal !== 'SESSION_REVOKED') await this.revoke(tx, session.id, refusal, now);
        return {
          error: oauthError(
            'invalid_grant',
            refusal === 'IDLE_TIMEOUT' ? 'Sessão expirada por inatividade.' : 'Sessão encerrada.',
          ),
        };
      }
      await tx.touchSession(session.id, now);
      return { tokens: await this.issue(tx, session, now, true) };
    });
    if ('error' in result) throw result.error;
    return result.tokens;
  }

  /** `client_credentials`: identidade de serviço com escopos mínimos (Autenticação §5.1). */
  async clientCredentials(p: {
    clientId: string;
    clientSecret: string;
    scope?: string;
  }): Promise<TokenResponse> {
    const now = this.d.clock.now();
    const client = await this.d.store.transaction((tx) => tx.client(p.clientId));
    const valid =
      client?.type === 'CONFIDENTIAL' && client.secretHash
        ? await this.d.hasher.verify(client.secretHash, p.clientSecret)
        : (await this.d.hasher.burn(), false);
    if (!client || !valid || client.realm !== 'services')
      throw oauthError('invalid_client', 'Credenciais do cliente inválidas.', 401);
    const requested = p.scope ? p.scope.split(' ').filter(Boolean) : client.allowedScopes;
    const denied = requested.filter((s) => !client.allowedScopes.includes(s));
    if (denied.length > 0)
      throw oauthError('invalid_scope', `Escopo não permitido: ${denied.join(', ')}.`);
    const scope = [...new Set(requested)].sort().join(' ');
    const { token } = await this.d.signer.accessToken(
      {
        sub: client.clientId,
        realm: 'services',
        client_id: client.clientId,
        roles: [],
        scope,
        amr: [],
      },
      now,
      ACCESS_TOKEN_TTL_MS,
    );
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      scope,
    };
  }

  /** Logout pelo refresh token: encerra a sessão dele. */
  async logout(refreshToken: string): Promise<void> {
    const now = this.d.clock.now();
    await this.d.store.transaction(async (tx) => {
      const row = await tx.refreshByHash(this.d.random.sha256(refreshToken));
      if (row) await this.revoke(tx, row.sessionId, 'LOGOUT', now);
    });
  }

  /** Emite o access token (claims completos) e, se pedido, um refresh novo da mesma família. */
  private async issue(
    tx: IdentityTx,
    session: SessionRow,
    now: Instant,
    withRefresh: boolean,
  ): Promise<TokenResponse> {
    const access = await this.accessFor(tx, session, now);
    if (!withRefresh) return access;
    const refresh = this.d.random.token();
    await tx.insertRefresh({
      id: this.d.newId(),
      sessionId: session.id,
      tokenHash: this.d.random.sha256(refresh),
      issuedAt: now,
      expiresAt: session.expiresAt,
      rotatedAt: null,
    });
    return { ...access, refresh_token: refresh };
  }

  private async accessFor(
    tx: IdentityTx,
    session: SessionRow,
    now: Instant,
  ): Promise<TokenResponse> {
    const user = await requireUser(tx, session.userId);
    const claims: AccessClaims = {
      sub: user.id,
      realm: user.realm,
      ...(user.accountId ? { account_id: user.accountId } : {}),
      roles: user.realm === 'backoffice' ? await tx.roles(user.id) : [],
      scope: session.scope,
      session_id: session.id,
      amr: session.amr,
      ...(session.mfaAt ? { mfa_time: Math.floor(session.mfaAt.epochMillis / 1000) } : {}),
      client_id: session.clientId,
    };
    const { token } = await this.d.signer.accessToken(claims, now, ACCESS_TOKEN_TTL_MS);
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      scope: session.scope,
    };
  }

  // ---------------------------------------------------------------- sessões e dispositivos

  async sessions(caller: Caller) {
    return this.d.store.transaction(async (tx) => {
      const devices = new Map((await tx.devices(caller.userId)).map((d) => [d.id, d]));
      return (await tx.activeSessions(caller.userId, this.d.clock.now())).map((s) => ({
        id: s.id,
        channel: s.channel,
        deviceId: s.deviceId,
        userAgent: devices.get(s.deviceId)?.userAgent ?? null,
        createdAt: s.createdAt.toString(),
        lastActivityAt: s.lastActivityAt.toString(),
        current: s.id === caller.sessionId,
      }));
    });
  }

  async devices(caller: Caller) {
    return this.d.store.transaction(async (tx) =>
      (await tx.devices(caller.userId)).map((d) => ({
        id: d.id,
        channel: d.channel,
        userAgent: d.userAgent,
        firstSeenAt: d.firstSeenAt.toString(),
        lastSeenAt: d.lastSeenAt.toString(),
      })),
    );
  }

  /** O usuário revoga uma sessão sua (RN-AUTH-013); a de outro usuário responde 404. */
  async revokeSession(caller: Caller, sessionId: string): Promise<void> {
    const now = this.d.clock.now();
    await this.d.store.transaction(async (tx) => {
      const s = await tx.session(sessionId, { forUpdate: true });
      if (!s || s.userId !== caller.userId || s.revokedAt)
        throw new IdentityError(404, 'NOT_FOUND', 'Sessão inexistente.');
      await this.revoke(tx, sessionId, 'USER', now);
    });
  }

  /**
   * Encerra a sessão: refresh e assinaturas deixam de valer, e a lista de revogação do Valkey
   * derruba os access tokens já emitidos até expirarem (no gateway e nos serviços).
   */
  async revoke(tx: IdentityTx, sessionId: string, reason: string, now: Instant): Promise<void> {
    const session = await tx.session(sessionId);
    if (!session || !(await tx.revokeSession(sessionId, reason, now))) return;
    await this.d.revocation.revokeSession(sessionId, ACCESS_TOKEN_TTL_MS);
    for (const t of await tx.revokeSignatureTokens({ sessionId }, now)) {
      await this.d.revocation.revokeSignature(t.jti, t.expiresAt.epochMillis - now.epochMillis);
    }
    await tx.publish(
      { type: 'identity.session_revoked', payload: { userId: session.userId, sessionId, reason } },
      session.userId,
    );
  }

  async revokeAll(tx: IdentityTx, userId: string, reason: string, now: Instant): Promise<void> {
    for (const s of await tx.activeSessions(userId, now)) await this.revoke(tx, s.id, reason, now);
  }

  /** Step-up (RN-AUTHZ-003): prova um fator agora e recebe um access token com `mfa_time` novo. */
  async stepUp(caller: Caller, proof: FactorProof): Promise<TokenResponse> {
    const now = this.d.clock.now();
    return this.d.store.transaction(async (tx) => {
      const session = await activeSession(tx, caller, now);
      const challenge = proof.method === 'WEBAUTHN' ? session.stepUpChallenge : null;
      if (challenge) await tx.setStepUpChallenge(session.id, null);
      const amr = await this.factors.verify(tx, caller.userId, proof, challenge);
      await tx.recordMfa(session.id, [amr, 'mfa'], now);
      return this.accessFor(tx, (await tx.session(session.id))!, now);
    });
  }

  /** Desafio WebAuthn do step-up, guardado na sessão até a resposta. */
  async stepUpWebauthnOptions(caller: Caller): Promise<{ options: object }> {
    return this.d.store.transaction(async (tx) => {
      await activeSession(tx, caller, this.d.clock.now());
      const { options, challenge } = await this.factors.webauthnAssertion(tx, caller.userId);
      await tx.setStepUpChallenge(caller.sessionId, challenge);
      return { options };
    });
  }

  /** Inatividade do desktop escolhida pelo usuário: de 2 h até 8 h (RN-AUTH-012). */
  async setDesktopIdle(caller: Caller, minutes: number): Promise<void> {
    const ms = minutes * 60_000;
    if (!Number.isInteger(minutes) || minutes < 120 || ms > DESKTOP_IDLE_MAX_MS)
      throw new IdentityError(400, 'INVALID_VALUE', 'Escolha entre 120 e 480 minutos.', 'minutes');
    await this.d.store.transaction((tx) => tx.updateUser(caller.userId, { desktopIdleMs: ms }));
  }

  // ---------------------------------------------------------------- internos

  private async publicClient(tx: IdentityTx, req: AuthorizeRequest): Promise<ClientRow> {
    const client = await tx.client(req.clientId);
    if (!client || client.type !== 'PUBLIC' || client.realm === 'services')
      throw oauthError('invalid_client', 'Cliente desconhecido.');
    if (!client.redirectUris.includes(req.redirectUri))
      throw oauthError('invalid_request', 'redirect_uri não cadastrado para o cliente.');
    if (req.codeChallengeMethod !== 'S256' || !CHALLENGE.test(req.codeChallenge))
      throw oauthError('invalid_request', 'PKCE obrigatório com code_challenge_method=S256.');
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(req.deviceId))
      throw new IdentityError(400, 'INVALID_DEVICE_ID', 'deviceId inválido.', 'deviceId');
    return client;
  }

  private scopeFor(realm: Realm, requested?: string): string {
    if (realm === 'backoffice') return 'backoffice';
    if (!requested) return DEFAULT_CUSTOMER_SCOPE;
    const scopes = requested.split(' ').filter(Boolean);
    const unknown = scopes.filter((s) => !(CUSTOMER_SCOPES as readonly string[]).includes(s));
    if (unknown.length > 0)
      throw oauthError('invalid_scope', `Escopo desconhecido: ${unknown.join(', ')}.`);
    return [...new Set(scopes)].sort().join(' ');
  }

  private async liveTransaction(tx: IdentityTx, mfaToken: string, forUpdate = false) {
    const t = await tx.loginTransaction(this.d.random.sha256(mfaToken), { forUpdate });
    if (!t || t.consumedAt || !this.d.clock.now().isBefore(t.expiresAt))
      throw new IdentityError(
        401,
        'MFA_CHALLENGE_EXPIRED',
        'A etapa de verificação expirou. Entre de novo.',
      );
    return t;
  }

  private async logAttempt(
    tx: IdentityTx,
    realm: Realm,
    emailHash: string,
    userId: string | null,
    success: boolean,
    reason: string | null,
    ipHash: string | undefined,
    attempt: number,
    now: Instant,
  ): Promise<void> {
    await tx.insertLoginAttempt({
      id: this.d.newId(),
      realm,
      emailHash,
      userId,
      success,
      reason,
      ipHash: ipHash ?? null,
      at: now,
    });
    if (!success) {
      await tx.publish(
        {
          type: 'identity.login_failed',
          payload: {
            emailHash,
            reason: reason!,
            ...(ipHash ? { ipHash } : {}),
            attemptCount: attempt,
          },
        },
        emailHash,
      );
    }
  }

  /** RN-AUTH-002: na 10ª falha, o titular recebe e-mail (só quando o usuário existe, claro). */
  private async lockNotice(user: UserRow): Promise<void> {
    const email = this.d.fields.open(user.emailEnc, CTX.email);
    await this.d.messenger.email(
      email,
      'Acesso bloqueado temporariamente',
      'Registramos 10 tentativas de acesso sem sucesso e bloqueamos o login por 30 minutos.\n\n' +
        'Se não foi você, troque sua senha assim que o bloqueio terminar.',
    );
  }
}

/** Atraso progressivo ou bloqueio: a mesma resposta exista o e-mail ou não. */
const lockedError = (until: Instant) =>
  new IdentityError(
    429,
    'LOGIN_TEMPORARILY_LOCKED',
    'Muitas tentativas. Tente de novo mais tarde.',
    undefined,
    until,
  );
