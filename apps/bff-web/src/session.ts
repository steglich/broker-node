// BFF token handler (RN-AUTH-010): o BFF conduz Authorization Code + PKCE com o identity e guarda os
// tokens em cookies HttpOnly/Secure/SameSite=Strict. Nenhum token vai para o corpo ou para scripts.
import { HttpError, unauthenticated, type ExecutionContext } from '@broker/service-kit';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { SignatureScope } from './routes.js';
import type { UpstreamResult, Upstreams } from './upstream.js';

export const COOKIES = {
  /** Access token: vai em toda requisição à API (o gateway e o BFF leem). */
  access: '__Host-broker_at',
  /** Refresh token: só nas rotas de autenticação. */
  refresh: '__Secure-broker_rt',
  /** Identificador do navegador para "novo dispositivo" (RN-AUTH-013). */
  device: '__Host-broker_device',
  /** Login no meio do MFA: o verifier do PKCE e o desafio, cifrados. */
  login: '__Secure-broker_login',
  signature: (scope: SignatureScope) => `__Host-broker_sig_${scope.toLowerCase()}`,
} as const;

const AUTH_PATH = '/v1/auth';
const REFRESH_MAX_AGE_S = 30 * 24 * 3600;
const DEVICE_MAX_AGE_S = 400 * 24 * 3600;
const LOGIN_MAX_AGE_S = 5 * 60;

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* cookie malformado: ignora */
    }
  }
  return out;
}

export function cookie(
  name: string,
  value: string,
  opts: { maxAgeS: number; path?: string; httpOnly?: boolean },
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? '/'}`,
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeS))}`,
    ...(opts.httpOnly === false ? [] : ['HttpOnly']),
    'Secure',
    'SameSite=Strict',
  ].join('; ');
}

const clear = (name: string, path = '/') => cookie(name, '', { maxAgeS: 0, path });

/** O `session_id` do access token, sem conferir a assinatura (quem confere é a autenticação). */
export function sessionIdOf(accessToken: string): string | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString(),
    );
    return typeof payload.session_id === 'string' ? payload.session_id : undefined;
  } catch {
    return undefined;
  }
}

export interface TokenHandlerOptions {
  upstreams: Upstreams;
  clientId: string;
  redirectUri: string;
  /** Segredo do HMAC anti-CSRF e chave (32 bytes) do cookie de login em andamento. */
  csrfSecret: Buffer;
  loginKey: Buffer;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

/** Corpo do canal: o resultado do login, nunca os tokens. */
export interface HandlerOut {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  cookies: string[];
  /** Erro a responder depois de gravar os cookies (ex.: limpar a sessão que acabou). */
  error?: HttpError;
}

export class TokenHandler {
  constructor(private readonly o: TokenHandlerOptions) {}

  /** Anti-CSRF (Segurança de aplicação): HMAC da sessão, igual em todas as abas e renovações. */
  csrfFor(sessionId: string): string {
    return createHmac('sha256', this.o.csrfSecret).update(sessionId).digest('base64url');
  }

  checkCsrf(accessToken: string, header: string | undefined): boolean {
    const sid = sessionIdOf(accessToken);
    if (!sid || !header) return false;
    const a = Buffer.from(this.csrfFor(sid));
    const b = Buffer.from(header);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async login(
    input: { email: string; password: string },
    cookies: Record<string, string>,
    req: { headers: Record<string, string | string[] | undefined>; ctx: ExecutionContext },
  ): Promise<HandlerOut> {
    const out: string[] = [];
    let device = cookies[COOKIES.device];
    if (!device || !/^[0-9a-f-]{36}$/.test(device)) {
      device = randomUUID();
      out.push(cookie(COOKIES.device, device, { maxAgeS: DEVICE_MAX_AGE_S }));
    }
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const r = await this.o.upstreams.call('identity', {
      method: 'post',
      path: '/v1/oauth/authorize',
      body: {
        client_id: this.o.clientId,
        redirect_uri: this.o.redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        device_id: device,
        email: input.email,
        password: input.password,
      },
      headers: { ...req.headers, authorization: undefined },
      ctx: req.ctx,
    });
    return this.afterAuthorize(r, verifier, out, req);
  }

  async verifyMfa(
    proof: Record<string, unknown>,
    cookies: Record<string, string>,
    req: { headers: Record<string, string | string[] | undefined>; ctx: ExecutionContext },
  ): Promise<HandlerOut> {
    const pending = this.openLogin(cookies[COOKIES.login]);
    const r = await this.o.upstreams.call('identity', {
      method: 'post',
      path: '/v1/oauth/authorize/mfa',
      body: { ...proof, mfa_token: pending.mfaToken },
      headers: { ...req.headers, authorization: undefined },
      ctx: req.ctx,
    });
    return this.afterAuthorize(r, pending.verifier, [], req);
  }

  async webauthnOptions(
    cookies: Record<string, string>,
    req: { headers: Record<string, string | string[] | undefined>; ctx: ExecutionContext },
  ): Promise<HandlerOut> {
    const pending = this.openLogin(cookies[COOKIES.login]);
    const r = await this.o.upstreams.call('identity', {
      method: 'post',
      path: '/v1/oauth/authorize/mfa/webauthn-options',
      body: { mfa_token: pending.mfaToken },
      headers: { ...req.headers, authorization: undefined },
      ctx: req.ctx,
    });
    return { status: r.status, body: r.body, headers: r.headers, cookies: [] };
  }

  async refresh(
    cookies: Record<string, string>,
    req: { headers: Record<string, string | string[] | undefined>; ctx: ExecutionContext },
  ): Promise<HandlerOut> {
    const refresh = cookies[COOKIES.refresh];
    if (!refresh) throw this.expired();
    const r = await this.o.upstreams.call('identity', {
      method: 'post',
      path: '/v1/oauth/token',
      body: { grant_type: 'refresh_token', refresh_token: refresh, client_id: this.o.clientId },
      headers: { ...req.headers, authorization: undefined },
      ctx: req.ctx,
    });
    if (r.status !== 200) {
      // Refresh vencido, revogado ou reusado (a família inteira cai): a sessão acabou.
      return { status: 401, cookies: this.clearAll(), error: this.expired() };
    }
    return this.authenticated(r.body as TokenResponse, []);
  }

  async logout(
    cookies: Record<string, string>,
    req: { headers: Record<string, string | string[] | undefined>; ctx: ExecutionContext },
  ): Promise<HandlerOut> {
    const refresh = cookies[COOKIES.refresh];
    if (refresh)
      await this.o.upstreams.call('identity', {
        method: 'post',
        path: '/v1/oauth/revoke',
        body: { token: refresh },
        headers: { ...req.headers, authorization: undefined },
        ctx: req.ctx,
      });
    return { status: 204, cookies: this.clearAll() };
  }

  /** Step-up (RN-AUTHZ-003): o novo access token vai para o cookie, não para o corpo. */
  async stepUp(
    proof: unknown,
    req: { headers: Record<string, string | string[] | undefined>; ctx: ExecutionContext },
  ): Promise<HandlerOut> {
    const r = await this.o.upstreams.call('identity', {
      method: 'post',
      path: '/v1/me/step-up',
      body: proof,
      headers: req.headers,
      ctx: req.ctx,
    });
    if (r.status !== 200)
      return { status: r.status, body: r.body, headers: r.headers, cookies: [] };
    const t = r.body as TokenResponse;
    return {
      status: 200,
      body: { status: 'STEPPED_UP', expiresIn: t.expires_in },
      cookies: [cookie(COOKIES.access, t.access_token, { maxAgeS: t.expires_in })],
    };
  }

  /** Assinatura eletrônica (RN-SIG-003): o token de curta duração fica num cookie por escopo. */
  async verifySignature(
    input: unknown,
    req: { headers: Record<string, string | string[] | undefined>; ctx: ExecutionContext },
    nowMs: number,
  ): Promise<HandlerOut> {
    const r = await this.o.upstreams.call('identity', {
      method: 'post',
      path: '/v1/me/trading-signature/verify',
      body: input,
      headers: req.headers,
      ctx: req.ctx,
    });
    if (r.status !== 200)
      return { status: r.status, body: r.body, headers: r.headers, cookies: [] };
    const s = r.body as { signatureToken: string; scope: SignatureScope; expiresAt: string };
    return {
      status: 200,
      body: { scope: s.scope, expiresAt: s.expiresAt },
      cookies: [
        cookie(COOKIES.signature(s.scope), s.signatureToken, {
          maxAgeS: (Date.parse(s.expiresAt) - nowMs) / 1000,
        }),
      ],
    };
  }

  private async afterAuthorize(
    r: UpstreamResult,
    verifier: string,
    out: string[],
    req: { headers: Record<string, string | string[] | undefined>; ctx: ExecutionContext },
  ): Promise<HandlerOut> {
    if (r.status !== 200)
      return { status: r.status, body: r.body, headers: r.headers, cookies: out };
    const result = r.body as
      | { status: 'AUTHORIZED'; code: string; redirectUri: string }
      | { status: 'MFA_REQUIRED'; mfaToken: string; methods: string[]; expiresAt: string };
    if (result.status === 'MFA_REQUIRED') {
      out.push(
        cookie(COOKIES.login, this.sealLogin({ verifier, mfaToken: result.mfaToken }), {
          maxAgeS: LOGIN_MAX_AGE_S,
          path: AUTH_PATH,
        }),
      );
      return {
        status: 200,
        body: { status: 'MFA_REQUIRED', methods: result.methods, expiresAt: result.expiresAt },
        cookies: out,
      };
    }
    const t = await this.o.upstreams.call('identity', {
      method: 'post',
      path: '/v1/oauth/token',
      body: {
        grant_type: 'authorization_code',
        code: result.code,
        code_verifier: verifier,
        client_id: this.o.clientId,
        redirect_uri: this.o.redirectUri,
      },
      headers: { ...req.headers, authorization: undefined },
      ctx: req.ctx,
    });
    if (t.status !== 200)
      throw new HttpError(401, 'LOGIN_FAILED', 'Não foi possível concluir o login. Tente de novo.');
    out.push(clear(COOKIES.login, AUTH_PATH));
    return this.authenticated(t.body as TokenResponse, out);
  }

  private authenticated(t: TokenResponse, out: string[]): HandlerOut {
    out.push(cookie(COOKIES.access, t.access_token, { maxAgeS: t.expires_in }));
    if (t.refresh_token)
      out.push(
        cookie(COOKIES.refresh, t.refresh_token, { maxAgeS: REFRESH_MAX_AGE_S, path: AUTH_PATH }),
      );
    const sid = sessionIdOf(t.access_token);
    return {
      status: 200,
      body: {
        status: 'AUTHENTICATED',
        expiresIn: t.expires_in,
        ...(sid ? { csrfToken: this.csrfFor(sid) } : {}),
      },
      cookies: out,
    };
  }

  private clearAll(): string[] {
    return [
      clear(COOKIES.access),
      clear(COOKIES.refresh, AUTH_PATH),
      clear(COOKIES.login, AUTH_PATH),
      ...(['ORDERS', 'WITHDRAWALS', 'SETTINGS'] as const).map((s) => clear(COOKIES.signature(s))),
    ];
  }

  private expired() {
    return unauthenticated('Sessão encerrada: entre de novo.');
  }

  private sealLogin(p: { verifier: string; mfaToken: string }): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.o.loginKey, iv);
    const enc = Buffer.concat([c.update(JSON.stringify(p), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
  }

  private openLogin(sealed: string | undefined): { verifier: string; mfaToken: string } {
    const fail = () =>
      new HttpError(401, 'LOGIN_EXPIRED', 'O login expirou. Informe e-mail e senha de novo.');
    if (!sealed) throw fail();
    try {
      const raw = Buffer.from(sealed, 'base64url');
      const d = createDecipheriv('aes-256-gcm', this.o.loginKey, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      const json = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
      return JSON.parse(json) as { verifier: string; mfaToken: string };
    } catch {
      throw fail();
    }
  }
}
