// Serviços implantáveis afetados pela mudança (Turborepo --affected): os pacotes em apps/ com
// src/main.ts, inclusive os que mudam só porque uma dependência do workspace mudou.
// Base da comparação: TURBO_SCM_BASE (o CI define; localmente, o padrão do turbo é `main`).
//
//   node infra/ci/affected-apps.mjs [--all]   → ["pix-simulator","kyc-simulator"]
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const deployable = (path) =>
  path.startsWith('apps/') && existsSync(join(root, path, 'src', 'main.ts'));

let paths;
if (process.argv.includes('--all')) {
  paths = readdirSync(join(root, 'apps')).map((name) => `apps/${name}`);
} else {
  const out = execFileSync('pnpm', ['exec', 'turbo', 'ls', '--affected', '--output', 'json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  paths = JSON.parse(out).packages.items.map((p) => p.path);
}
console.log(
  JSON.stringify(
    paths
      .filter(deployable)
      .map((p) => p.slice('apps/'.length))
      .sort(),
  ),
);
