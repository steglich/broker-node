// Acesso ao ambiente local como um cliente de fora: HTTPS no Traefik com a CA do mkcert, cookies
// do token handler e o anti-CSRF da sessão (RN-AUTH-010). Nada aqui fala direto com um banco.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { fileURLToPath } from 'node:url';
import { sleep } from '@broker/testing';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Lê um segredo gerado em infra/secrets/ (o mesmo arquivo que vira Docker secret). */
export const secret = (name: string): string =>
  readFileSync(`${root}infra/secrets/${name}`, 'utf8').trim();

export const ports = {
  https: Number(process.env['HTTPS_PORT'] ?? 443),
  mailpit: Number(process.env['MAILPIT_UI_PORT'] ?? 8025),
  postgres: Number(process.env['POSTGRES_PORT'] ?? 5432),
};

// *.broker.localhost sempre aponta para a máquina local; não depende do resolvedor do sistema.
const lookup: LookupFunction = (_host, opts, cb) =>
  opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);

let ca: Buffer | undefined;
const caCert = () =>
  (ca ??= readFileSync(fileURLToPath(new URL('../../infra/certs/ca/rootCA.pem', import.meta.url))));

export interface HttpResponse<B = unknown> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: B;
}

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Corpo binário já pronto (upload de documento), enviado como está. */
  raw?: Buffer;
}

/** Uma requisição HTTP(S); `https://*.broker.localhost` passa pelo Traefik com a CA local. */
export function http<B = unknown>(url: string, req: HttpRequest = {}): Promise<HttpResponse<B>> {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const payload =
    req.raw ?? (req.body !== undefined ? Buffer.from(JSON.stringify(req.body)) : undefined);
  const headers: Record<string, string> = {
    accept: 'application/json, application/problem+json',
    ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(payload ? { 'content-length': String(payload.length) } : {}),
    ...req.headers,
  };
  const send = secure ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = send(
      {
        method: req.method ?? 'GET',
        host: u.hostname,
        port: u.port ? Number(u.port) : secure ? ports.https : 80,
        path: u.pathname + u.search,
        headers,
        ...(u.hostname.endsWith('.broker.localhost') ? { lookup, ca: caCert() } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const type = String(res.headers['content-type'] ?? '');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: (text && type.includes('json') ? JSON.parse(text) : text) as B,
          });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Falha com o corpo da resposta quando o status não é o esperado (mensagem útil no CI). */
export function expectStatus<B>(res: HttpResponse<B>, ...expected: number[]): HttpResponse<B> {
  if (!expected.includes(res.status))
    throw new Error(
      `esperado ${expected.join('/')}, recebido ${res.status}: ${JSON.stringify(res.body)}`,
    );
  return res;
}

export const urls = {
  api: 'https://api.broker.localhost',
  scheduler: 'https://scheduler.broker.localhost',
  bank: 'https://bank.broker.localhost',
  sms: 'https://sms.broker.localhost',
  mailpit: `http://localhost:${ports.mailpit}`,
};

/**
 * Sessão do canal web pela borda: guarda os cookies que o BFF grava (access, refresh, dispositivo,
 * assinatura) e manda o `X-CSRF-Token` em todo comando, como o front faria.
 */
export class WebSession {
  private readonly cookies = new Map<string, string>();
  private csrf: string | undefined;

  constructor(private readonly base = urls.api) {}

  async request<B = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<HttpResponse<B>> {
    // Uma chave por operação (RN-API-010); a mesma nas repetições depois de um 429.
    const idempotencyKey = method === 'GET' ? undefined : randomUUID();
    for (let attempt = 0; ; attempt++) {
      const res = await http<B>(this.base + path, {
        method,
        headers: {
          'x-client-channel': 'WEB',
          'x-client-version': '1.0.0',
          ...(this.cookies.size
            ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
            : {}),
          ...(this.csrf && method !== 'GET' ? { 'x-csrf-token': this.csrf } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      });
      this.store(res.headers['set-cookie']);
      // As rotas públicas têm limite por IP (API §6): espera o Retry-After em vez de falhar.
      if (res.status === 429 && attempt < 5) {
        await sleep(Number(res.headers['retry-after'] ?? 5) * 1000);
        continue;
      }
      return res;
    }
  }

  get = <B = unknown>(path: string) => this.request<B>('GET', path);
  post = <B = unknown>(path: string, body?: unknown) => this.request<B>('POST', path, body ?? {});
  put = <B = unknown>(path: string, body?: unknown) => this.request<B>('PUT', path, body ?? {});
  delete = <B = unknown>(path: string) => this.request<B>('DELETE', path);

  /**
   * Login pelo token handler. Sem fator forte cadastrado, termina direto em `AUTHENTICATED`; com
   * autenticador, o BFF pede o MFA e `mfaCode` dá o código TOTP.
   */
  async login(email: string, password: string, mfaCode?: () => string): Promise<void> {
    type LoginResult = { status: string; csrfToken?: string };
    let res = expectStatus(
      await this.post<LoginResult>('/v1/auth/login', { email, password }),
      200,
    );
    if (res.body.status === 'MFA_REQUIRED' && mfaCode)
      res = expectStatus(
        await this.post<LoginResult>('/v1/auth/mfa/verify', { method: 'TOTP', code: mfaCode() }),
        200,
      );
    if (res.body.status !== 'AUTHENTICATED' || !res.body.csrfToken)
      throw new Error(`login não autenticou: ${JSON.stringify(res.body)}`);
    this.csrf = res.body.csrfToken;
  }

  /** Claims do access token atual (sem conferir a assinatura), para diagnóstico. */
  accessClaims(): Record<string, unknown> | null {
    const token = this.cookies.get('__Host-broker_at');
    if (!token) return null;
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  }

  hasCookie(name: string): boolean {
    return this.cookies.has(name);
  }

  private store(setCookie: string | string[] | undefined): void {
    for (const line of [setCookie ?? []].flat()) {
      const [pair, ...attrs] = line.split(';');
      const i = pair!.indexOf('=');
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}
