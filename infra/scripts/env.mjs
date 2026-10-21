// Comandos do ambiente local (D22): pnpm env:up [infra|core|full] | env:down | env:logs | env:seed
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSecrets } from './secrets.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const composeFile = join(root, 'infra', 'compose', 'compose.yml');
const PROFILES = ['infra', 'core', 'full'];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** `infra` não ativa perfil: a infraestrutura não tem perfil e sobe sempre. `full` inclui `core`. */
function profileArgs(profile) {
  if (profile === 'infra') return [];
  if (profile === 'core') return ['--profile', 'core'];
  return ['--profile', 'core', '--profile', 'full'];
}

const compose = (args, profile = 'full') =>
  run('docker', ['compose', '-f', composeFile, ...profileArgs(profile), ...args]);

/**
 * Espera todos os contêineres do perfil ficarem prontos: os que têm healthcheck precisam
 * estar `healthy`, e os one-shot (migrações, init de buckets, certificados) precisam ter
 * terminado com código 0. Não usamos `up --wait` porque ele trata one-shot encerrado como falha.
 */
async function waitReady(profile, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  // Só os serviços do perfil pedido: contêineres parados de outros perfis (ex.: um serviço do
  // perfil full que caiu quando a máquina desligou) não contam.
  const services = new Set(
    execFileSync(
      'docker',
      ['compose', '-f', composeFile, ...profileArgs(profile), 'config', '--services'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    )
      .trim()
      .split('\n'),
  );
  for (;;) {
    const out = execFileSync(
      'docker',
      ['compose', '-f', composeFile, ...profileArgs(profile), 'ps', '-a', '--format', 'json'],
      { cwd: root, encoding: 'utf8' },
    );
    const containers = out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((c) => services.has(c.Service));
    const failed = containers.filter((c) => c.State === 'exited' && c.ExitCode !== 0);
    if (failed.length) {
      throw new Error(
        `falharam: ${failed.map((c) => `${c.Service} (exit ${c.ExitCode})`).join(', ')}`,
      );
    }
    const pending = containers.filter((c) =>
      c.State === 'exited' ? false : c.Health ? c.Health !== 'healthy' : c.State !== 'running',
    );
    if (!pending.length) return;
    if (Date.now() > deadline) {
      throw new Error(`tempo esgotado esperando: ${pending.map((c) => c.Service).join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const [command = 'help', ...rest] = process.argv.slice(2);

switch (command) {
  case 'up': {
    const profile = rest[0] ?? 'infra';
    if (!PROFILES.includes(profile)) {
      console.error(`perfil inválido: ${profile} (use ${PROFILES.join(', ')})`);
      process.exit(1);
    }
    const created = generateSecrets();
    if (created.length) console.log(`segredos gerados: ${created.length}`);
    compose(['up', '-d', '--build', '--remove-orphans'], profile);
    try {
      await waitReady(profile);
    } catch (err) {
      console.error(String(err));
      console.error('veja os logs com: pnpm env:logs <serviço>');
      process.exit(1);
    }
    // O init do Postgres só roda sozinho com o volume vazio; rodar de novo aplica
    // serviços novos do catálogo e sincroniza senhas (o script é idempotente).
    compose(
      ['exec', '-T', 'postgres', 'bash', '/docker-entrypoint-initdb.d/01-services.sh'],
      profile,
    );
    console.log(`\nambiente '${profile}' pronto.`);
    break;
  }
  case 'down':
    // --volumes apaga os dados (bancos, filas, buckets).
    compose(['down', '--remove-orphans', ...rest]);
    break;
  case 'logs':
    compose(['logs', '-f', '--tail', '200', ...rest]);
    break;
  case 'ps':
    compose(['ps', '-a', ...rest]);
    break;
  case 'seed':
    // Cada serviço publica sua semente idempotente num script `seed` (RN-ENV-031).
    run('pnpm', ['-r', '--if-present', 'run', 'seed']);
    break;
  default:
    console.log(
      'uso: pnpm env:up [infra|core|full] | env:down [--volumes] | env:logs [serviço] | env:ps | env:seed',
    );
}
