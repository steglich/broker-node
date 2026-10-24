// Convenção de commits do repositório (RN-CICD-021) e versionamento semântico por serviço
// (RN-CICD-020). Uma só gramática para o verificador de mensagens (commitlint.mjs) e para o
// changelog (release.mjs): o que passa no verificador é exatamente o que o changelog entende.
//
//   <tipo>(<escopo>)!: <descrição>
//
//   feat(pix-simulator): adiciona devolução parcial
//   fix(service-kit,webhooks)!: troca o header de assinatura
//
//   BREAKING CHANGE: <o que quebra>        (no corpo, alternativa ao `!`)

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Tipos aceitos e a seção do changelog em que aparecem (`null`: não entra no changelog). */
export const TYPES = {
  feat: 'Novidades',
  fix: 'Correções',
  perf: 'Desempenho',
  refactor: null,
  docs: null,
  test: null,
  build: null,
  ci: null,
  chore: null,
  style: null,
  revert: 'Reversões',
};

/** Escopos que não são pacotes do workspace. */
export const GENERIC_SCOPES = [
  'infra',
  'ci',
  'deps',
  'docs',
  'estudos',
  'openspec',
  'repo',
  'release',
];

const HEADER =
  /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9-]+(?:,[a-z0-9-]+)*)\))?(?<bang>!)?: (?<subject>.+)$/;
export const MAX_HEADER = 100;

/**
 * Pacotes versionados do workspace: diretório e nome curto (o nome do pacote sem `@broker/`).
 * O nome curto é o escopo do commit e o prefixo da tag (`pix-simulator@0.2.0`).
 */
export function workspacePackages(root) {
  const out = [];
  for (const group of ['apps', 'packages']) {
    for (const name of readdirSync(join(root, group)).sort()) {
      if (existsSync(join(root, group, name, 'package.json')))
        out.push({ dir: `${group}/${name}`, name });
    }
  }
  for (const dir of ['contracts', 'scenarios']) {
    if (existsSync(join(root, dir, 'package.json'))) out.push({ dir, name: dir });
  }
  return out;
}

/** Interpreta uma mensagem de commit; `null` se o cabeçalho não segue a convenção. */
export function parseCommit(message) {
  const [header = '', ...rest] = message.split('\n');
  const match = HEADER.exec(header.trim());
  if (!match) return null;
  const body = rest.join('\n');
  const breakingNote = /^BREAKING[ -]CHANGE: (.+)$/m.exec(body);
  return {
    type: match.groups.type,
    scopes: match.groups.scope ? match.groups.scope.split(',') : [],
    subject: match.groups.subject.trim(),
    breaking: Boolean(match.groups.bang) || Boolean(breakingNote),
    breakingNote: breakingNote?.[1]?.trim() ?? null,
  };
}

/** Problemas de uma mensagem (lista vazia: ok). Merge e revert automáticos do git passam. */
export function lintMessage(message, knownScopes) {
  const header = message.split('\n')[0] ?? '';
  if (/^Merge /.test(header) || /^Revert "/.test(header)) return [];
  const problems = [];
  const commit = parseCommit(message);
  if (!commit) {
    return [
      `cabeçalho fora da convenção: "${header}". Use <tipo>(<escopo>): <descrição>, ex.: feat(pix-simulator): adiciona devolução`,
    ];
  }
  if (!(commit.type in TYPES))
    problems.push(`tipo desconhecido "${commit.type}"; use: ${Object.keys(TYPES).join(', ')}`);
  for (const scope of commit.scopes) {
    if (!knownScopes.has(scope))
      problems.push(
        `escopo desconhecido "${scope}"; use o nome curto de um pacote ou: ${GENERIC_SCOPES.join(', ')}`,
      );
  }
  if (header.length > MAX_HEADER)
    problems.push(`cabeçalho com ${header.length} caracteres (máximo ${MAX_HEADER})`);
  if (/\.$/.test(commit.subject)) problems.push('a descrição não termina com ponto');
  const lines = message.split('\n');
  if (lines.length > 1 && lines[1].trim() !== '')
    problems.push('deixe uma linha em branco entre o cabeçalho e o corpo');
  return problems;
}

/** Tipo de incremento pelos commits (RN-CICD-020). Antes da 1.0, quebra sobe o minor. */
export function bumpFor(commits, currentVersion) {
  const parsed = commits.map((c) => c.parsed).filter(Boolean);
  const major = Number(currentVersion.split('.')[0]);
  if (parsed.some((c) => c.breaking)) return major === 0 ? 'minor' : 'major';
  if (parsed.some((c) => c.type === 'feat')) return 'minor';
  if (parsed.some((c) => c.type === 'fix' || c.type === 'perf' || c.type === 'revert'))
    return 'patch';
  return null;
}

export function nextVersion(version, bump) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Seção do CHANGELOG.md de uma versão. */
export function renderChangelog(version, date, commits) {
  const lines = [`## ${version} (${date})`, ''];
  const parsed = commits.filter((c) => c.parsed);
  const breaking = parsed.filter((c) => c.parsed.breaking);
  if (breaking.length > 0) {
    lines.push('### Mudanças incompatíveis', '');
    for (const c of breaking)
      lines.push(`- ${c.parsed.breakingNote ?? c.parsed.subject} (${c.hash.slice(0, 7)})`);
    lines.push('');
  }
  for (const [type, title] of Object.entries(TYPES)) {
    if (!title) continue;
    const items = parsed.filter((c) => c.parsed.type === type);
    if (items.length === 0) continue;
    lines.push(`### ${title}`, '');
    for (const c of items) lines.push(`- ${c.parsed.subject} (${c.hash.slice(0, 7)})`);
    lines.push('');
  }
  return lines.join('\n');
}
