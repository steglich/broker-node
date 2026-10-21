import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkCompatibility, type VersionedSchemas } from './compat.js';
import { generateArtifacts, type JsonSchema } from './generate.js';
import type { Registry } from './registry.js';

const EVENT_SCHEMA = /^events\/([^/]+)\/v(\d+)\.schema\.json$/;

/** Agrupa os esquemas de evento de um mapa `caminho → conteúdo` (relativo a `generated/`). */
export function eventSchemasOf(files: ReadonlyMap<string, string>): VersionedSchemas {
  const out: VersionedSchemas = {};
  for (const [path, content] of files) {
    const match = EVENT_SCHEMA.exec(path);
    if (!match) continue;
    (out[match[1]!] ??= {})[Number(match[2])] = JSON.parse(content) as JsonSchema;
  }
  return out;
}

const git = (repo: string, args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * Lê os esquemas gerados de `generatedDir` (caminho relativo à raiz do repositório) numa
 * referência git, sem mexer na árvore de trabalho. Sem a pasta na base (primeiro contrato), vazio.
 */
export function readGeneratedAtRef(
  repo: string,
  ref: string,
  generatedDir = 'contracts/generated',
): Map<string, string> {
  const files = new Map<string, string>();
  const list = git(repo, ['ls-tree', '-r', '--name-only', ref, '--', `${generatedDir}/`]);
  for (const path of list.split('\n').filter(Boolean)) {
    files.set(path.slice(generatedDir.length + 1), git(repo, ['show', `${ref}:${path}`]));
  }
  return files;
}

export function readGeneratedOnDisk(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(dir)) return files;
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(relative(dir, full).split('\\').join('/'), readFileSync(full, 'utf8'));
    }
  };
  walk(dir);
  return files;
}

export interface CheckResult {
  ok: boolean;
  problems: string[];
}

/**
 * O check do CI (D8, RN-MSG-B-020..023):
 * 1. `generated/` em disco precisa bater com o que os contratos geram (ninguém esquece o generate);
 * 2. os esquemas de evento atuais precisam ser compatíveis com os da base (`main`).
 */
export function runCheck(input: {
  registry: Registry;
  onDisk: ReadonlyMap<string, string>;
  base: ReadonlyMap<string, string>;
  allowRemoved?: readonly string[];
}): CheckResult {
  const problems: string[] = [];
  const expected = generateArtifacts(input.registry);
  for (const [path, content] of expected) {
    const disk = input.onDisk.get(path);
    if (disk === undefined)
      problems.push(`generated/${path} não existe: rode pnpm contracts:generate`);
    else if (disk !== content)
      problems.push(`generated/${path} desatualizado: rode pnpm contracts:generate`);
  }
  for (const path of input.onDisk.keys()) {
    if (!expected.has(path))
      problems.push(`generated/${path} sem contrato de origem: rode pnpm contracts:generate`);
  }
  const compat = checkCompatibility(eventSchemasOf(input.base), eventSchemasOf(expected), {
    ...(input.allowRemoved ? { allowRemoved: input.allowRemoved } : {}),
  });
  problems.push(...compat.problems);
  return { ok: problems.length === 0, problems };
}
