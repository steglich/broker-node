import type { AuditEntry } from './record.js';

/** Valor gravado no lugar de um dado sensível: o registro mostra que mudou, não o valor (RN-AUD-003). */
export const MASK = '***';

const normalize = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Campos mascarados em `before`/`after`: dados pessoais (os mesmos que o publicador recusa em
 * eventos) e segredos. A comparação ignora caixa, `_` e `-` (`phone_number` = `phoneNumber`).
 */
export const SENSITIVE_FIELDS: ReadonlySet<string> = new Set(
  [
    'cpf',
    'taxId',
    'document',
    'documentNumber',
    'rg',
    'address',
    'endereco',
    'street',
    'zipCode',
    'cep',
    'phone',
    'phoneNumber',
    'telefone',
    'mobile',
    'email',
    'birthDate',
    'motherName',
    'income',
    'renda',
    'patrimony',
    'bankAccount',
    'pixKey',
    'password',
    'senha',
    'secret',
    'token',
    'accessToken',
    'refreshToken',
    'signature',
    'assinatura',
    'totp',
    'otp',
  ].map(normalize),
);

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Troca todo valor de campo sensível por `***`, em qualquer nível. */
export function mask(value: unknown, depth = 0): unknown {
  if (depth > 16 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => mask(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_FIELDS.has(normalize(k)) && v !== null ? MASK : mask(v, depth + 1);
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Caminhos (`a.b.c`) que diferem entre `before` e `after`, comparando os valores originais. */
export function changedFields(before: unknown, after: unknown, prefix = ''): string[] {
  if (!isObject(before) || !isObject(after)) {
    return prefix && !same(before, after) ? [prefix] : [];
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((k) => changedFields(before[k], after[k], prefix ? `${prefix}.${k}` : k));
}

/** O que a trilha precisa de um evento do barramento (envelope RN-MSG-B §4). */
export interface CapturedEvent {
  eventId: string;
  eventType: string;
  source: string;
  occurredAt: string;
  partitionKey: string;
  correlationId: string;
  actor: { type: string; id: string };
  auditable: boolean;
  payload: Record<string, unknown>;
}

/** A trilha guarda os eventos `auditable` e os `audit.*` dos BFFs (Segurança de aplicação §3.1). */
export const isAuditable = (e: Pick<CapturedEvent, 'auditable' | 'eventType'>): boolean =>
  e.auditable || e.eventType.startsWith('audit.');

/**
 * Campos de auditoria que um evento pode trazer no payload (convenção dos eventos `audit.*`, e
 * opcional nos demais). Sem eles, o recurso é o agregado do evento (`partitionKey`) e o `after` é
 * o próprio payload.
 */
const AUDIT_FIELDS = [
  'actorRoles',
  'resourceType',
  'resourceId',
  'before',
  'after',
  'justification',
  'approvalRequestId',
  'ip',
  'userAgent',
] as const;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Normaliza um instante para ISO UTC com milissegundos (o que o banco devolve). */
export const isoMillis = (value: string): string => {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`instante inválido: ${value}`);
  return new Date(ms).toISOString();
};

/** Monta a entrada da trilha a partir de um evento, com `before`/`after` mascarados (RN-AUD-003). */
export function entryFromEvent(e: CapturedEvent, recordedAt: string): AuditEntry {
  const p = e.payload;
  const isAuditEvent = e.eventType.startsWith('audit.');
  const rest = Object.fromEntries(
    Object.entries(p).filter(([k]) => !(AUDIT_FIELDS as readonly string[]).includes(k)),
  );
  const before = p['before'] ?? null;
  const after = p['after'] ?? (isAuditEvent || Object.keys(rest).length === 0 ? null : rest);
  const roles = Array.isArray(p['actorRoles'])
    ? p['actorRoles'].filter((r): r is string => typeof r === 'string')
    : [];
  return {
    eventId: e.eventId,
    actorType: e.actor.type,
    actorId: e.actor.id,
    actorRoles: [...new Set(roles)].sort(),
    action: e.eventType,
    resourceType: str(p['resourceType']) ?? e.eventType.split('.')[0]!,
    resourceId: str(p['resourceId']) ?? e.partitionKey,
    before: mask(before),
    after: mask(after),
    changedFields: before !== null && after !== null ? changedFields(before, after) : [],
    justification: str(p['justification']),
    approvalRequestId: str(p['approvalRequestId']),
    ip: str(p['ip']),
    userAgent: str(p['userAgent']),
    source: e.source,
    occurredAt: isoMillis(e.occurredAt),
    recordedAt: isoMillis(recordedAt),
    correlationId: e.correlationId,
  };
}
