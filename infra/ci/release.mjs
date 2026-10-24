// Versão semântica e changelog por serviço (RN-CICD-020/021), a partir dos commits.
//
//   node infra/ci/release.mjs            mostra o plano (padrão)
//   node infra/ci/release.mjs --apply    grava versões e CHANGELOG.md, faz o commit e cria as tags
//
// Cada pacote do workspace tem a própria linha de versões, com tags `<nome>@<versão>`
// (ex.: `pix-simulator@0.2.0`). Entram os commits que tocam a pasta do pacote desde a última tag.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  bumpFor,
  nextVersion,
  parseCommit,
  renderChangelog,
  workspacePackages,
} from './conventional.mjs';

const { values } = parseArgs({
  options: { apply: { type: 'boolean', default: false }, repo: { type: 'string' } },
});
const root =
  values.repo ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

function commitsOf(dir, since) {
  const range = since ? [`${since}..HEAD`] : ['HEAD'];
  const log = git('log', '--format=%H%x1f%B%x1e', ...range, '--', dir);
  return log
    .split('\x1e')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash, message] = entry.split('\x1f');
      return { hash, message: message.trim(), parsed: parseCommit(message.trim()) };
    })
    .reverse();
}

const date = git('log', '-1', '--format=%cs');
const plan = [];
for (const pkg of workspacePackages(root)) {
  const file = join(root, pkg.dir, 'package.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const lastTag = git('tag', '--list', `${pkg.name}@*`, '--sort=-v:refname').split('\n')[0] || null;
  const commits = commitsOf(pkg.dir, lastTag);
  const bump = bumpFor(commits, manifest.version);
  if (!bump) continue;
  const version = nextVersion(manifest.version, bump);
  plan.push({ pkg, file, manifest, from: manifest.version, version, bump, commits });
}

if (plan.length === 0) {
  console.log('nada a publicar: nenhum feat/fix/perf/quebra desde a última versão de cada pacote');
  process.exit(0);
}
for (const p of plan)
  console.log(`${p.pkg.name}: ${p.from} → ${p.version} (${p.bump}, ${p.commits.length} commit(s))`);
if (!values.apply) {
  console.log('\n(plano; rode com --apply para gravar, commitar e criar as tags)');
  process.exit(0);
}

for (const p of plan) {
  p.manifest.version = p.version;
  writeFileSync(p.file, `${JSON.stringify(p.manifest, null, 2)}\n`);
  const changelog = join(root, p.pkg.dir, 'CHANGELOG.md');
  const previous = existsSync(changelog)
    ? readFileSync(changelog, 'utf8').replace(/^# .*\n+/, '')
    : '';
  writeFileSync(
    changelog,
    `# Changelog — ${p.pkg.name}\n\n${renderChangelog(p.version, date, p.commits)}\n${previous}`.trimEnd() +
      '\n',
  );
  git('add', p.file, changelog);
}
const released = plan.map((p) => `${p.pkg.name}@${p.version}`);
git(
  'commit',
  '-m',
  `chore(release): publica ${released.length} pacote(s)`,
  '-m',
  released.map((r) => `- ${r}`).join('\n'),
);
for (const tag of released) git('tag', '-a', tag, '-m', tag);
console.log(`\ncommit e tags criados: ${released.join(', ')} (faça o push com --follow-tags)`);
