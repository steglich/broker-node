// Verifica mensagens de commit contra a convenção (infra/ci/conventional.mjs).
//
//   node infra/ci/commitlint.mjs --file .git/COMMIT_EDITMSG   (hook commit-msg)
//   node infra/ci/commitlint.mjs --from <base> [--to HEAD]    (CI: os commits do PR)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { GENERIC_SCOPES, lintMessage, workspacePackages } from './conventional.mjs';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string', default: 'HEAD' },
  },
});
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const scopes = new Set([...workspacePackages(root).map((p) => p.name), ...GENERIC_SCOPES]);

const messages = [];
if (values.file) {
  // Linhas de comentário do editor do git não fazem parte da mensagem.
  const text = readFileSync(values.file, 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .trim();
  messages.push({ id: 'mensagem', text });
} else if (values.from) {
  const log = execFileSync(
    'git',
    ['log', '--format=%H%x1f%B%x1e', `${values.from}..${values.to}`],
    { encoding: 'utf8' },
  );
  for (const entry of log
    .split('\x1e')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const [hash, text] = entry.split('\x1f');
    messages.push({ id: hash.slice(0, 7), text: text.trim() });
  }
} else {
  console.error('uso: commitlint.mjs --file <arquivo> | --from <base> [--to <ref>]');
  process.exit(2);
}

let failed = 0;
for (const { id, text } of messages) {
  const problems = lintMessage(text, scopes);
  if (problems.length === 0) continue;
  failed++;
  console.error(`✗ ${id}: ${text.split('\n')[0]}`);
  for (const p of problems) console.error(`    ${p}`);
}
if (failed) {
  console.error(`\n${failed} commit(s) fora da convenção (veja CONTRIBUTING.md).`);
  process.exit(1);
}
console.log(`${messages.length} commit(s) na convenção.`);
