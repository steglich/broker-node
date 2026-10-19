import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { LeaderElector } from '../src/index.js';
import { configFor, superuserConfig } from './helpers.js';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));

interface Candidate {
  proc: ChildProcess;
  output: string[];
  waitFor(line: string, timeoutMs?: number): Promise<void>;
}

const children: ChildProcess[] = [];
const electors: LeaderElector[] = [];

function startCandidate(name: string): Candidate {
  // Um único processo Node com o loader do tsx. (O CLI `tsx` cria um processo filho, e um
  // SIGKILL nele deixaria o candidato real vivo, segurando o lock.)
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', '--conditions=source', 'test/fixtures/leader-candidate.ts'],
    {
      cwd: pkgDir,
      env: {
        ...process.env,
        LEADER_DB: JSON.stringify(configFor('leader', 'app')),
        LEADER_NAME: name,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(proc);
  const output: string[] = [];
  const collect = (chunk: Buffer) => output.push(...chunk.toString().split('\n').filter(Boolean));
  proc.stdout!.on('data', collect);
  proc.stderr!.on('data', collect);
  return {
    proc,
    output,
    waitFor: (line, timeoutMs = 15_000) =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = setInterval(() => {
          if (output.some((l) => l.startsWith(line))) {
            clearInterval(poll);
            resolve();
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(poll);
            reject(
              new Error(`não apareceu "${line}" em ${timeoutMs} ms; saída: ${output.join(' | ')}`),
            );
          }
        }, 50);
      }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(electors.splice(0).map((e) => e.stop()));
});

describe('eleição de líder por advisory lock (RN-ENV-021)', () => {
  it('RN-ENV-021: com dois processos só um é líder, e o outro assume quando o primeiro morre', async () => {
    const a = startCandidate('scheduler');
    await a.waitFor('ELECTED');
    const b = startCandidate('scheduler');
    await b.waitFor('STARTED');
    await sleep(1000); // vários heartbeats de B: continua em espera
    expect(b.output).not.toContain('ELECTED');

    a.proc.kill('SIGKILL'); // morte abrupta: sem stop(), sem soltar o lock na mão
    await b.waitFor('ELECTED');
    expect(b.output.filter((l) => l === 'ELECTED')).toHaveLength(1);
  });

  it('papéis diferentes têm líderes independentes', async () => {
    const a = startCandidate('scheduler');
    const b = startCandidate('brapi-queue');
    await Promise.all([a.waitFor('ELECTED'), b.waitFor('ELECTED')]);
  });

  it('stop() solta a liderança na hora e o candidato em espera assume', async () => {
    const events: string[] = [];
    const make = (id: string) => {
      const e = new LeaderElector({
        database: configFor('leader', 'app'),
        name: 'risk-partition-0',
        heartbeatMs: 100,
        onElected: () => events.push(`${id}:elected`),
        onRevoked: () => events.push(`${id}:revoked`),
      });
      electors.push(e);
      return e;
    };
    const first = make('first');
    const second = make('second');
    await first.start();
    await second.start();
    expect([first.isLeader(), second.isLeader()]).toEqual([true, false]);
    await first.stop();
    await expect.poll(() => second.isLeader(), { timeout: 5000 }).toBe(true);
    expect(events).toEqual(['first:elected', 'first:revoked', 'second:elected']);
  });

  it('o líder percebe a perda da sessão (conexão encerrada no servidor) e deixa de liderar', async () => {
    const revoked: string[] = [];
    const elector = new LeaderElector({
      database: configFor('leader', 'app'),
      name: 'ledger-relay',
      heartbeatMs: 100,
      onRevoked: (reason) => revoked.push(reason),
      onError: () => undefined, // a queda da conexão é esperada neste teste
    });
    electors.push(elector);
    await elector.start();
    expect(elector.isLeader()).toBe(true);

    // Um administrador derruba a sessão do líder (como uma queda de rede do lado do servidor).
    const admin = new pg.Client(superuserConfig('leader'));
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'leader:ledger-relay'`,
    );
    await admin.end();

    await expect.poll(() => revoked.length, { timeout: 5000 }).toBeGreaterThan(0);
    // Sem concorrente, ele reconecta e volta a ser líder.
    await expect.poll(() => elector.isLeader(), { timeout: 5000 }).toBe(true);
  });
});
