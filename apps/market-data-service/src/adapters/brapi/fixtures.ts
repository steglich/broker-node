import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from './provider.js';

/**
 * Resposta gravada da brapi (`fixtures/brapi/*.json`, RN-BRP-100). `origin = recorded` veio da
 * brapi real sem token; `synthetic` segue o mesmo formato onde a gravação exige token ou um erro.
 */
export interface BrapiFixture {
  origin: 'recorded' | 'synthetic';
  recordedAt: string;
  note?: string;
  request: { path: string; query: Record<string, string> };
  response: {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
    bodyText?: string;
  };
}

/** Pasta das fixtures do pacote (fora de `src/`, vale para `src` e `dist`). */
export const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/brapi/', import.meta.url));

export function loadFixture(name: string, dir = FIXTURES_DIR): BrapiFixture {
  return JSON.parse(
    readFileSync(join(dir, name.endsWith('.json') ? name : `${name}.json`), 'utf8'),
  );
}

export function loadFixtures(dir = FIXTURES_DIR): BrapiFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => loadFixture(f, dir));
}

const key = (path: string, query: Record<string, string>) =>
  `${path}?${Object.keys(query)
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&')}`;

/** Corpo e cabeçalhos de uma fixture como resposta HTTP. */
export function asResponse(f: BrapiFixture): Awaited<ReturnType<FetchLike>> {
  const headers = new Map(
    Object.entries(f.response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const text = f.response.bodyText ?? JSON.stringify(f.response.body);
  return {
    status: f.response.status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: async () => text,
  };
}

/**
 * `fetch` sobre as fixtures (adaptador `fixture`, RN-BRP-095): casa caminho e parâmetros. Pedido
 * sem fixture responde `404` no formato da brapi (ticker sem cotação), sem rede e sem cota.
 */
export function fixtureFetch(fixtures: readonly BrapiFixture[] = loadFixtures()): FetchLike {
  const byKey = new Map(fixtures.map((f) => [key(f.request.path, f.request.query), f]));
  return async (url) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api/, '');
    const query = Object.fromEntries(u.searchParams.entries());
    const hit = byKey.get(key(path, query));
    if (hit) return asResponse(hit);
    return asResponse({
      origin: 'synthetic',
      recordedAt: '2026-10-27',
      request: { path, query },
      response: {
        status: 404,
        body: {
          error: true,
          message: `Não encontramos ${query['symbols'] ?? path}`,
          code: 'NOT_FOUND',
        },
      },
    });
  };
}
