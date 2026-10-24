/**
 * Verificação de contratos do CI (D8, RN-MSG-B-020..023): `generated/` atualizado e esquemas de
 * evento compatíveis com a base. Sai com código 1 se houver problema.
 *
 *   pnpm contracts:check [--base main] [--repo .] [--allow-removed "<eventType> v<N>"]...
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readGeneratedAtRef, readGeneratedOnDisk, runCheck } from '../check.js';
import { loadRegistry } from '../registry.js';
import { CONTRACTS_ROOT } from './paths.js';

const { values } = parseArgs({
  // `pnpm contracts:check --base x` chega como `-- --base x`: o separador do pnpm não é argumento.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    base: { type: 'string', default: process.env['CONTRACTS_BASE_REF'] ?? 'main' },
    repo: { type: 'string' },
    'allow-removed': { type: 'string', multiple: true, default: [] },
  },
});
const repo =
  values.repo ??
  execFileSync('git', ['-C', CONTRACTS_ROOT, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();

const result = runCheck({
  registry: await loadRegistry(CONTRACTS_ROOT),
  onDisk: readGeneratedOnDisk(join(CONTRACTS_ROOT, 'generated')),
  base: readGeneratedAtRef(repo, values.base),
  allowRemoved: values['allow-removed'],
});

if (result.ok) {
  console.log(`contratos OK (base: ${values.base})`);
} else {
  console.error(`contratos reprovados (base: ${values.base}):`);
  for (const problem of result.problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
}
