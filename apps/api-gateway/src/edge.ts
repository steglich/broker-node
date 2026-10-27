// Regras da borda sem E/S (RN-API §3, §6, §7): classificação da rota, versão mínima por canal,
// CORS e headers de segurança.

export const CHANNELS = ['WEB', 'MOBILE', 'DESKTOP', 'BACKOFFICE'] as const;
export type Channel = (typeof CHANNELS)[number];
export const isChannel = (v: string | undefined): v is Channel =>
  (CHANNELS as readonly string[]).includes(v ?? '');

/** Realm exigido por canal: o backoffice nunca aceita token de cliente (RN-BO-002). */
export const REALM_OF: Record<Channel, 'customers' | 'backoffice'> = {
  WEB: 'customers',
  MOBILE: 'customers',
  DESKTOP: 'customers',
  BACKOFFICE: 'backoffice',
};

/**
 * Rotas sem token (login, cadastro, recuperação e renovação): limite por IP com atraso progressivo.
 * Tudo o mais exige token válido (RN-AUTHZ-001: negar por padrão).
 */
const PUBLIC_ROUTES: readonly { method: string; path: RegExp }[] = [
  { method: 'POST', path: /^\/v1\/auth\/(login|register|logout|token\/refresh)$/ },
  { method: 'POST', path: /^\/v1\/auth\/mfa\/(verify|webauthn-options)$/ },
  { method: 'POST', path: /^\/v1\/auth\/password-reset(\/(methods|sms|complete))?$/ },
];

/** Rotas públicas que contam falhas para o atraso progressivo (RN-AUTH-002, API §6). */
const CREDENTIAL_ROUTES = /^\/v1\/auth\/(login|mfa\/verify)$/;

export type Bucket = 'PUBLIC' | 'READ' | 'COMMAND';

export interface Classified {
  public: boolean;
  bucket: Bucket;
  /** Geração de relatórios: limite próprio por hora, além do de comandos. */
  report: boolean;
  credentials: boolean;
}

export function classify(method: string, path: string): Classified {
  const m = method.toUpperCase();
  const isPublic = PUBLIC_ROUTES.some((r) => r.method === m && r.path.test(path));
  return {
    public: isPublic,
    bucket: isPublic ? 'PUBLIC' : m === 'GET' || m === 'HEAD' ? 'READ' : 'COMMAND',
    report: m === 'POST' && /^\/v1\/me\/reports\/?$/.test(path),
    credentials: isPublic && CREDENTIAL_ROUTES.test(path),
  };
}

export interface Limit {
  limit: number;
  windowMs: number;
}

/** Limites padrão (API §6). */
export const DEFAULT_LIMITS: Record<Bucket | 'REPORT', Limit> = {
  PUBLIC: { limit: 10, windowMs: 60_000 },
  READ: { limit: 600, windowMs: 60_000 },
  COMMAND: { limit: 120, windowMs: 60_000 },
  REPORT: { limit: 10, windowMs: 3_600_000 },
};

/** Atraso progressivo depois de falhas seguidas de credencial: 3 → 250 ms, dobrando até 8 s. */
export const progressiveDelayMs = (failures: number): number =>
  failures < 3 ? 0 : Math.min(250 * 2 ** (failures - 3), 8_000);

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function parseVersion(v: string): [number, number, number] | null {
  const m = SEMVER.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionBelow(version: string, minimum: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/** `WEB=1.0.0,MOBILE=2.3.0` → mapa por canal. */
export function parseChannelMap(text: string): Partial<Record<Channel, string>> {
  const out: Partial<Record<Channel, string>> = {};
  for (const part of text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [k, ...rest] = part.split('=');
    const key = k!.trim().toUpperCase();
    if (!isChannel(key) || rest.length === 0) throw new Error(`entrada inválida: ${part}`);
    out[key] = rest.join('=').trim();
  }
  return out;
}

/** RN-API-041: em toda resposta da borda. A API não serve HTML, então a CSP fecha tudo. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'X-Frame-Options': 'DENY',
};

export const CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'If-Match',
  'X-Correlation-Id',
  'X-Client-Channel',
  'X-Client-Version',
  'X-Trading-Signature',
  'X-CSRF-Token',
  'traceparent',
  'tracestate',
].join(', ');

export const CORS_EXPOSED_HEADERS = [
  'X-Correlation-Id',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'Retry-After',
  'ETag',
  'Idempotent-Replayed',
  'Location',
].join(', ');

/** Corpo máximo (RN-API-042): 64 KB, salvo os prefixos com limite próprio. */
export function bodyLimitFor(
  path: string,
  exceptions: readonly { prefix: string; bytes: number }[],
) {
  return exceptions.find((e) => path.startsWith(e.prefix))?.bytes ?? 64 * 1024;
}
