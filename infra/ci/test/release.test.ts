import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const releaseScript = fileURLToPath(new URL('../release.mjs', import.meta.url));

/** Repositório descartável com dois pacotes, como o workspace. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'release-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  for (const [group, name] of [
    ['apps', 'pix-simulator'],
    ['packages', 'service-kit'],
  ]) {
    mkdirSync(join(dir, group, name), { recursive: true });
    writeFileSync(
      join(dir, group, name, 'package.json'),
      JSON.stringify({ name: `@broker/${name}`, version: '0.1.0' }, null, 2) + '\n',
    );
  }
  git('add', '.');
  git('commit', '-q', '-m', 'chore: estrutura inicial');
  const change = (path: string, message: string) => {
    writeFileSync(join(dir, path), `${Math.random()}`);
    git('add', '.');
    git('commit', '-q', '-m', message);
  };
  const release = (...args: string[]) =>
    execFileSync('node', [releaseScript, '--repo', dir, ...args], { encoding: 'utf8' });
  return { dir, git, change, release };
}

describe('release por serviço (RN-CICD-020/021)', () => {
  it('cada pacote sobe conforme os commits que tocam a sua pasta, com changelog e tag', () => {
    const r = repo();
    r.change('apps/pix-simulator/a.ts', 'feat(pix-simulator): adiciona devolução');
    r.change('apps/pix-simulator/b.ts', 'fix(pix-simulator): corrige saldo');
    r.change('packages/service-kit/c.ts', 'fix(service-kit): corrige timeout');
    r.change('packages/service-kit/d.ts', 'docs(service-kit): explica o timeout');

    expect(r.release()).toContain('pix-simulator: 0.1.0 → 0.2.0 (minor, 3 commit(s))');
    r.release('--apply');

    const version = (p: string) =>
      JSON.parse(readFileSync(join(r.dir, p, 'package.json'), 'utf8')).version;
    expect(version('apps/pix-simulator')).toBe('0.2.0');
    expect(version('packages/service-kit')).toBe('0.1.1');
    expect(r.git('tag', '--list').split('\n').sort()).toEqual([
      'pix-simulator@0.2.0',
      'service-kit@0.1.1',
    ]);
    expect(r.git('log', '-1', '--format=%s')).toBe('chore(release): publica 2 pacote(s)');
    const changelog = readFileSync(join(r.dir, 'apps/pix-simulator/CHANGELOG.md'), 'utf8');
    expect(changelog).toMatch(/^# Changelog — pix-simulator\n\n## 0\.2\.0 \(\d{4}-\d{2}-\d{2}\)/);
    expect(changelog).toContain('### Novidades\n\n- adiciona devolução');
    expect(changelog).toContain('### Correções\n\n- corrige saldo');
    expect(readFileSync(join(r.dir, 'packages/service-kit/CHANGELOG.md'), 'utf8')).not.toContain(
      'explica o timeout',
    );
  });

  it('a próxima versão só considera os commits depois da última tag', () => {
    const r = repo();
    r.change('apps/pix-simulator/a.ts', 'feat(pix-simulator): primeira');
    r.release('--apply');
    expect(r.release()).toContain('nada a publicar');
    r.change('apps/pix-simulator/b.ts', 'fix(pix-simulator): segunda');
    r.release('--apply');
    const changelog = readFileSync(join(r.dir, 'apps/pix-simulator/CHANGELOG.md'), 'utf8');
    expect(changelog.indexOf('## 0.2.1')).toBeLessThan(changelog.indexOf('## 0.2.0'));
    expect(changelog.split('## 0.2.1')[1]!.split('## 0.2.0')[0]).not.toContain('primeira');
  });
});
