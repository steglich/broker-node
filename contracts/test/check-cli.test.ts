import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const contractsRoot = fileURLToPath(new URL('../', import.meta.url));
const schemaPath = 'contracts/generated/events/example.pinged/v1.schema.json';

/** Repositório git descartável cujo commit faz o papel do `main`. */
function baseRepo(schema: object): string {
  const repo = mkdtempSync(join(tmpdir(), 'contracts-base-'));
  mkdirSync(dirname(join(repo, schemaPath)), { recursive: true });
  writeFileSync(join(repo, schemaPath), JSON.stringify(schema, null, 2));
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  return repo;
}

function runCheck(repo: string) {
  return spawnSync(
    'pnpm',
    ['exec', 'tsx', '--conditions=source', 'src/bin/check.ts', '--repo', repo, '--base', 'main'],
    {
      cwd: contractsRoot,
      encoding: 'utf8',
    },
  );
}

describe('pnpm contracts:check contra o main (RN-MSG-B-020..023)', () => {
  const current = JSON.parse(
    readFileSync(join(contractsRoot, 'generated/events/example.pinged/v1.schema.json'), 'utf8'),
  );

  it('passa quando o main tem o mesmo esquema', () => {
    const result = runCheck(baseRepo(current));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('RN-MSG-B-021: remover um campo obrigatório sem subir a versão reprova o script', () => {
    // No main, example.pinged v1 tinha `source` obrigatório; o contrato atual não tem mais.
    const main = structuredClone(current);
    main.properties.source = { type: 'string' };
    main.required = [...main.required, 'source'];
    const result = runCheck(baseRepo(main));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'example.pinged v1: payload.source: campo obrigatório removido — crie v2',
    );
  });
});
