import { sql, type SelectQueryBuilder } from 'kysely';
import { validationError } from './errors.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
/** Período máximo por consulta (RN-API-022): 1 ano. */
export const MAX_PERIOD_DAYS = 366;

export interface Sort {
  /** Coluna no banco. */
  column: string;
  direction: 'asc' | 'desc';
}

export interface PageQuery {
  limit: number;
  cursor?: { value: string; id: string };
  sort: Sort;
}

export interface Page<T> {
  items: T[];
  /** Ausente no fim da lista (RN-API-020). */
  nextCursor?: string;
}

const encodeCursor = (value: string, id: string) =>
  Buffer.from(JSON.stringify([value, id])).toString('base64url');

function decodeCursor(cursor: string): { value: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((p) => typeof p === 'string')
    ) {
      return { value: parsed[0] as string, id: parsed[1] as string };
    }
  } catch {
    /* cai no erro abaixo */
  }
  throw validationError([
    { field: 'cursor', code: 'INVALID_CURSOR', message: 'Cursor inválido ou expirado.' },
  ]);
}

/**
 * Lê `limit`, `cursor` e `sort` (RN-API-020..023). `sort` aceita só os campos permitidos pelo
 * recurso (`sort=-createdAt` = decrescente). `limit` acima de 200: `clamp` (usa 200) ou `reject` (400).
 */
export function parsePageQuery(
  query: Record<string, unknown>,
  options: { sortable: Record<string, string>; defaultSort: string; overflow?: 'clamp' | 'reject' },
): PageQuery {
  let limit = DEFAULT_LIMIT;
  if (query['limit'] !== undefined) {
    limit = Number(query['limit']);
    if (!Number.isInteger(limit) || limit < 1) {
      throw validationError([
        { field: 'limit', code: 'INVALID_VALUE', message: 'limit precisa ser um inteiro ≥ 1.' },
      ]);
    }
    if (limit > MAX_LIMIT) {
      if (options.overflow === 'reject') {
        throw validationError([
          { field: 'limit', code: 'LIMIT_TOO_LARGE', message: `O máximo é ${MAX_LIMIT}.` },
        ]);
      }
      limit = MAX_LIMIT;
    }
  }
  const sortParam =
    typeof query['sort'] === 'string' && query['sort'] ? query['sort'] : options.defaultSort;
  const field = sortParam.replace(/^-/, '');
  const column = options.sortable[field];
  if (!column) {
    throw validationError([
      {
        field: 'sort',
        code: 'INVALID_VALUE',
        message: `Ordenação permitida: ${Object.keys(options.sortable).join(', ')}.`,
      },
    ]);
  }
  return {
    limit,
    sort: { column, direction: sortParam.startsWith('-') ? 'desc' : 'asc' },
    ...(typeof query['cursor'] === 'string' && query['cursor']
      ? { cursor: decodeCursor(query['cursor']) }
      : {}),
  };
}

/** Filtro de enum em lista (`status=NEW,PARTIALLY_FILLED`), só com valores permitidos. */
export function parseEnumList<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T[] | undefined {
  if (value === undefined || value === '') return undefined;
  const items = String(value)
    .split(',')
    .map((v) => v.trim());
  const invalid = items.filter((i) => !allowed.includes(i as T));
  if (invalid.length > 0) {
    throw validationError([
      { field, code: 'INVALID_VALUE', message: `Valores permitidos: ${allowed.join(', ')}.` },
    ]);
  }
  return items as T[];
}

/** Período `from`/`to` (datas ISO) com no máximo 1 ano (RN-API-022). */
export function parsePeriod(from: unknown, to: unknown): { from?: string; to?: string } {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const errors = [];
  if (from !== undefined && !iso.test(String(from)))
    errors.push({ field: 'from', code: 'INVALID_FORMAT', message: 'Use AAAA-MM-DD.' });
  if (to !== undefined && !iso.test(String(to)))
    errors.push({ field: 'to', code: 'INVALID_FORMAT', message: 'Use AAAA-MM-DD.' });
  if (errors.length) throw validationError(errors);
  if (from !== undefined && to !== undefined) {
    const days = (Date.parse(String(to)) - Date.parse(String(from))) / 86_400_000;
    if (days < 0)
      throw validationError([
        { field: 'to', code: 'INVALID_PERIOD', message: 'to precisa ser depois de from.' },
      ]);
    if (days > MAX_PERIOD_DAYS) {
      throw validationError([
        {
          field: 'to',
          code: 'PERIOD_TOO_LONG',
          message: 'O período máximo é de 1 ano; para mais, use relatórios.',
        },
      ]);
    }
  }
  return {
    ...(from !== undefined ? { from: String(from) } : {}),
    ...(to !== undefined ? { to: String(to) } : {}),
  };
}

/**
 * Aplica ordenação e cursor (keyset) numa consulta Kysely: ordena por `(coluna, id)` e continua
 * depois do último item. Busca `limit + 1` para saber se há próxima página. O índice composto
 * `(..., coluna, id)` sustenta a consulta (RN-DB-012).
 */
export function applyPage<DB, TB extends keyof DB, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  page: PageQuery,
  idColumn = 'id',
): SelectQueryBuilder<DB, TB, O> {
  const { column, direction } = page.sort;
  const op = direction === 'asc' ? sql.raw('>') : sql.raw('<');
  let q = qb;
  if (page.cursor) {
    // Comparação de tupla (coluna, id) > (valor, id): o banco converte os parâmetros para os tipos
    // das colunas e usa o índice composto.
    q = q.where(
      sql<boolean>`(${sql.ref(column)}, ${sql.ref(idColumn)}) ${op} (${page.cursor.value}, ${page.cursor.id})`,
    );
  }
  return q
    .orderBy(sql.ref(column), direction)
    .orderBy(sql.ref(idColumn), direction)
    .limit(page.limit + 1) as SelectQueryBuilder<DB, TB, O>;
}

/** Fecha a página: corta o item extra e gera o `nextCursor` a partir do último item. */
export function toPage<T>(
  rows: T[],
  page: PageQuery,
  keyOf: (row: T) => { value: string; id: string },
): Page<T> {
  const hasMore = rows.length > page.limit;
  const items = hasMore ? rows.slice(0, page.limit) : rows;
  if (!hasMore) return { items };
  const last = keyOf(items[items.length - 1]!);
  return { items, nextCursor: encodeCursor(last.value, last.id) };
}
