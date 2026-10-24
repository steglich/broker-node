import type { Clock } from '@broker/clock';
import type { Instant } from '@broker/domain-kernel';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type JSONWebKeySet,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { sql, type Kysely } from 'kysely';
import { CTX } from '../application/context.js';
import type { AccessClaims, FieldProtection, TokenSigner } from '../application/ports.js';

/** Chave aposentada continua na JWKS até o token mais longo que ela assinou expirar (8 h). */
const RETIRED_PUBLISHED_MS = 24 * 3_600_000;
const CACHE_MS = 60_000;

interface KeyRow {
  kid: string;
  private_enc: string;
  public_jwk: JWK;
  status: 'ACTIVE' | 'RETIRED';
  retired_at: Date | null;
}

/**
 * Tokens ES256 (D10) com chaves rotacionáveis em `signing_key`: a privada fica cifrada com a
 * chave de dados do serviço; a JWKS publica a ativa e as aposentadas recentes, então trocar a
 * chave não derruba os tokens já emitidos.
 */
export class JoseTokenSigner implements TokenSigner {
  private cache: { at: number; rows: KeyRow[] } | undefined;

  constructor(
    private readonly db: Kysely<unknown>,
    private readonly fields: FieldProtection,
    private readonly newId: () => string,
    private readonly clock: Clock,
    private readonly settings: { issuer: string; audience: string },
  ) {}

  /** Garante uma chave ativa (primeira subida). */
  async ensureKey(now: Instant): Promise<void> {
    if (!(await this.rows(now, true)).some((r) => r.status === 'ACTIVE')) await this.rotate(now);
  }

  async accessToken(claims: AccessClaims, now: Instant, ttlMs: number) {
    const jti = this.newId();
    const token = await this.sign({ ...claims }, 'at+jwt', now, ttlMs, jti, claims.sub);
    return { token, jti };
  }

  async signatureToken(
    claims: { sub: string; session_id: string; sig_scope: string; jti: string },
    now: Instant,
    ttlMs: number,
  ) {
    const { sub, jti, ...rest } = claims;
    return this.sign(rest, 'sig+jwt', now, ttlMs, jti, sub);
  }

  async jwks() {
    const now = this.clock.now().epochMillis;
    return {
      keys: (await this.rows())
        .filter(
          (r) =>
            r.status === 'ACTIVE' ||
            (r.retired_at && now - r.retired_at.getTime() < RETIRED_PUBLISHED_MS),
        )
        .map((r) => ({ ...r.public_jwk, kid: r.kid, alg: 'ES256', use: 'sig' })),
    };
  }

  /** Resolvedor de chaves para validar os próprios tokens sem ida à rede (rotas /v1/me). */
  keyResolver(): JWTVerifyGetKey {
    return async (header, token) =>
      createLocalJWKSet((await this.jwks()) as JSONWebKeySet)(header, token);
  }

  /** Nova chave ativa; a anterior vira aposentada (ainda publicada por 24 h). */
  async rotate(now: Instant): Promise<string> {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const kid = this.newId();
    const privateJwk = JSON.stringify(await exportJWK(privateKey));
    await this.db.transaction().execute(async (trx) => {
      await sql`UPDATE signing_key SET status = 'RETIRED', retired_at = ${now.toString()} WHERE status = 'ACTIVE'`.execute(
        trx,
      );
      await sql`
        INSERT INTO signing_key (kid, private_enc, public_jwk, status, created_at)
        VALUES (${kid}, ${this.fields.seal(privateJwk, CTX.signingKey)}, ${JSON.stringify(await exportJWK(publicKey))}::jsonb,
          'ACTIVE', ${now.toString()})`.execute(trx);
    });
    this.cache = undefined;
    return kid;
  }

  private async sign(
    payload: Record<string, unknown>,
    typ: string,
    now: Instant,
    ttlMs: number,
    jti: string,
    sub: string,
  ) {
    const active = (await this.rows()).find((r) => r.status === 'ACTIVE');
    if (!active) throw new Error('nenhuma chave de assinatura ativa');
    const key = await importJWK(
      JSON.parse(this.fields.open(active.private_enc, CTX.signingKey)) as JWK,
      'ES256',
    );
    const iat = Math.floor(now.epochMillis / 1000);
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', kid: active.kid, typ })
      .setIssuer(this.settings.issuer)
      .setAudience(this.settings.audience)
      .setSubject(sub)
      .setJti(jti)
      .setIssuedAt(iat)
      .setExpirationTime(iat + Math.max(1, Math.floor(ttlMs / 1000)))
      .sign(key);
  }

  /** As chaves mudam raramente: cache de 1 min (outra instância pode ter rotacionado). */
  private async rows(_now?: Instant, fresh = false): Promise<KeyRow[]> {
    if (!fresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.rows;
    const { rows } = await sql<KeyRow>`
      SELECT kid, private_enc, public_jwk, status, retired_at FROM signing_key ORDER BY created_at DESC LIMIT 10`.execute(
      this.db,
    );
    this.cache = { at: Date.now(), rows };
    return rows;
  }
}
