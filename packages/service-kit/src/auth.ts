import type { Clock } from '@broker/clock';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { Actor } from '@broker/messaging';
import { forbidden, notFound, unauthenticated } from './errors.js';

/** Claims do access token (Autenticação §4). */
export interface AccessClaims extends JWTPayload {
  realm?: 'customers' | 'backoffice' | 'services';
  account_id?: string;
  roles?: string[];
  scope?: string;
  session_id?: string;
  amr?: string[];
  client_id?: string;
}

export interface Principal {
  actor: Actor;
  accountId?: string;
  scopes: Set<string>;
  roles: Set<string>;
  claims: AccessClaims;
}

export interface AuthenticatorOptions {
  /** JWKS do identity-service (URL) ou um resolvedor de chaves (testes). */
  jwks: URL | JWTVerifyGetKey;
  issuer: string;
  audience: string;
  clock: Clock;
  /** Padrão ES256 (D10). */
  algorithms?: string[];
}

/** Valida tokens JWT pela JWKS e monta o principal (usuário, operador ou serviço). */
export class Authenticator {
  private readonly keys: JWTVerifyGetKey;

  constructor(private readonly options: AuthenticatorOptions) {
    this.keys = options.jwks instanceof URL ? createRemoteJWKSet(options.jwks) : options.jwks;
  }

  async authenticate(authorization: string | undefined): Promise<Principal> {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
    if (!token) throw unauthenticated();
    let claims: AccessClaims;
    try {
      ({ payload: claims } = await jwtVerify<AccessClaims>(token, this.keys, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: this.options.algorithms ?? ['ES256'],
        // Validade do token conferida no relógio do ambiente (RN-CLK-001).
        currentDate: new Date(this.options.clock.now().epochMillis),
      }));
    } catch {
      throw unauthenticated('Token inválido ou expirado.');
    }
    const scopes = new Set((claims.scope ?? '').split(' ').filter(Boolean));
    const roles = new Set(claims.roles ?? []);
    if (claims.realm === 'services') {
      return {
        actor: { type: 'SERVICE', id: claims.client_id ?? claims.sub ?? 'service' },
        scopes,
        roles,
        claims,
      };
    }
    if (!claims.sub) throw unauthenticated('Token sem sujeito.');
    return {
      actor: { type: claims.realm === 'backoffice' ? 'BACKOFFICE' : 'USER', id: claims.sub },
      ...(claims.account_id ? { accountId: claims.account_id } : {}),
      scopes,
      roles,
      claims,
    };
  }
}

/**
 * Política de acesso de uma rota (RN-AUTHZ-001: negar por padrão; toda rota declara a sua).
 * `public` precisa ser escrito explicitamente.
 */
export type AccessPolicy =
  | 'public'
  | {
      /** Escopos exigidos (todos). */
      scopes?: string[];
      /** Papéis aceitos (qualquer um), para o backoffice. */
      roles?: string[];
      /** Quem pode chamar: só usuários, só serviços ou ambos (padrão `user`). */
      principal?: 'user' | 'service' | 'any';
    };

export function authorize(principal: Principal, policy: Exclude<AccessPolicy, 'public'>): void {
  const kind = policy.principal ?? 'user';
  const isService = principal.actor.type === 'SERVICE';
  if ((kind === 'user' && isService) || (kind === 'service' && !isService)) {
    throw forbidden('FORBIDDEN', 'Este tipo de credencial não pode acessar esta rota.');
  }
  const missing = (policy.scopes ?? []).filter((s) => !principal.scopes.has(s));
  if (missing.length > 0)
    throw forbidden('INSUFFICIENT_SCOPE', `Escopo necessário: ${missing.join(', ')}.`);
  if (policy.roles && !policy.roles.some((r) => principal.roles.has(r))) {
    throw forbidden('FORBIDDEN', 'Seu papel não permite esta operação.');
  }
}

/**
 * Autorização por propriedade no caso de uso (RN-BE-012, RN-AUTHZ-002): o recurso precisa existir
 * e pertencer à conta do ator; senão a resposta é `404`, igual à de um recurso inexistente.
 */
export function ownedBy<T extends { accountId: string }>(
  resource: T | undefined | null,
  accountId: string | undefined,
): T {
  if (!resource || !accountId || resource.accountId !== accountId) throw notFound();
  return resource;
}

export interface ServiceTokenProviderOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  clock: Clock;
  /** Renova o token este tanto antes de expirar (padrão 30 s). */
  refreshSkewMs?: number;
}

/**
 * Token de serviço por *client credentials* (OAuth 2.1, RN-API-050), com escopos mínimos
 * (ex.: `risk:pretrade`). Guarda o token até perto de expirar.
 */
export class ServiceTokenProvider {
  private cached: { token: string; expiresAt: number } | undefined;
  private pending: Promise<string> | undefined;

  constructor(private readonly options: ServiceTokenProviderOptions) {}

  async token(): Promise<string> {
    const now = this.options.clock.now().epochMillis;
    if (this.cached && now < this.cached.expiresAt - (this.options.refreshSkewMs ?? 30_000))
      return this.cached.token;
    this.pending ??= this.fetchToken().finally(() => (this.pending = undefined));
    return this.pending;
  }

  private async fetchToken(): Promise<string> {
    const res = await fetch(this.options.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: this.options.scopes.join(' '),
      }),
    });
    if (!res.ok) throw new Error(`falha ao obter token de serviço: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = {
      token: body.access_token,
      expiresAt: this.options.clock.now().epochMillis + body.expires_in * 1000,
    };
    return body.access_token;
  }
}
