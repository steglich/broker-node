import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import Type from 'typebox';
import { describe, expect, it } from 'vitest';
import { BaseConfigProperties, ConfigError, loadConfig, packageVersion } from '../src/index.js';
import { sleep, testService } from './helpers.js';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const secretDir = mkdtempSync(join(tmpdir(), 'kit-secret-'));
writeFileSync(join(secretDir, 'api_secret'), 'segredo-super-123\n');

function runFixture(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', '--conditions=source', 'test/fixtures/config-service.ts'],
    {
      cwd: pkgDir,
      env: { PATH: process.env['PATH']!, ...env },
      encoding: 'utf8',
    },
  );
}

describe('configuração validada (RN-BE-060/061)', () => {
  const base = {
    SERVICE_NAME: 'ledger-service',
    ENVIRONMENT: 'prod',
    API_SECRET_FILE: join(secretDir, 'api_secret'),
  };

  it('RN-BE-061: sem DB_URL o processo encerra com código 1 e diz qual variável falta, sem expor segredos', () => {
    const run = runFixture({ ...base, PORT: 'abc' });
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain('CONFIG_OK');
    expect(run.stderr).toContain('[ledger-service] configuração inválida');
    expect(run.stderr).toContain('DB_URL: obrigatória e ausente');
    expect(run.stderr).toContain('PORT');
    expect(run.stderr).not.toContain('segredo-super-123');
    expect(run.stderr).not.toContain('abc');
  });

  it('RN-BE-060: com tudo certo, lê o segredo do arquivo (Docker secret) e aplica os padrões', () => {
    const run = runFixture({ ...base, DB_URL: 'postgres://ledger' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('CONFIG_OK ledger-service 8080');
  });

  it('valida tipos, converte números e aponta segredo curto sem mostrar o valor', () => {
    const Schema = Type.Object({
      ...BaseConfigProperties,
      API_SECRET: Type.String({ minLength: 8 }),
    });
    const err = (() => {
      try {
        loadConfig(Schema, {
          SERVICE_NAME: 'x',
          ENVIRONMENT: 'prod',
          API_SECRET: 'curto',
          PORT: '9090',
        });
      } catch (e) {
        return e as ConfigError;
      }
      return undefined;
    })();
    expect(err?.problems).toEqual(['API_SECRET: must NOT have fewer than 8 characters']);
    expect(err?.message).not.toContain('curto');
    expect(
      loadConfig(Schema, {
        SERVICE_NAME: 'x',
        ENVIRONMENT: 'prod',
        API_SECRET: '12345678',
        PORT: '9090',
      }).PORT,
    ).toBe(9090);
  });
});

describe('health e info (RN-OBS §5)', () => {
  it('liveness sempre UP; readiness DOWN enquanto o estado carrega ou uma dependência cai', async () => {
    let dbUp = true;
    const { service } = testService({
      readiness: {
        database: async () => {
          if (!dbUp) throw new Error('fora');
        },
      },
    });
    await request(service.app).get('/health/live').expect(200, { status: 'UP' });
    await request(service.app).get('/health/ready').expect(200);

    service.setReady(false); // ex.: Motor reconstruindo o livro a partir do journal
    const loading = await request(service.app).get('/health/ready').expect(503);
    expect(loading.body).toMatchObject({ status: 'DOWN', state: 'LOADING' });
    await request(service.app).get('/health/live').expect(200);

    service.setReady(true);
    dbUp = false;
    const down = await request(service.app).get('/health/ready').expect(503);
    expect(down.body.checks).toEqual({ database: 'DOWN' });
  });

  it('RN-CICD-020: /info expõe versão, commit, ambiente e início', async () => {
    const { service } = testService();
    const res = await request(service.app).get('/info').expect(200);
    expect(res.body).toMatchObject({
      service: 'test-service',
      version: '1.2.3',
      commit: 'abc1234',
      environment: 'prod',
    });
    expect(Date.parse(res.body.startedAt)).not.toBeNaN();
  });

  it('RN-CICD-020: a versão padrão é a do package.json do serviço; a variável sobrescreve', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-version-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@broker/x', version: '0.3.1' }),
    );
    expect(packageVersion(dir)).toBe('0.3.1');
    expect(packageVersion(join(dir, 'nao-existe'))).toBe('0.0.0');
    // Rodando a partir da pasta do pacote (como na imagem, em /app), o padrão é a versão dele.
    const own = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
    const schema = Type.Object(BaseConfigProperties);
    const env = { SERVICE_NAME: 'x', ENVIRONMENT: 'prod' };
    expect(loadConfig(schema, env).SERVICE_VERSION).toBe(packageVersion());
    expect(packageVersion(pkgDir)).toBe(own);
    expect(loadConfig(schema, { ...env, SERVICE_VERSION: '9.9.9' }).SERVICE_VERSION).toBe('9.9.9');
  });
});

describe('encerramento gracioso', () => {
  it('termina a requisição em andamento, recusa novas e fecha os recursos na ordem inversa', async () => {
    const { service } = testService();
    const closed: string[] = [];
    service.onShutdown('database', async () => void closed.push('database'));
    service.onShutdown('consumer', async () => void closed.push('consumer'));
    service.route({
      method: 'get',
      path: '/v1/slow',
      auth: 'public',
      handler: async () => {
        await sleep(400);
        return { body: { done: true } };
      },
    });
    const server = service.app.listen(0);
    const { port } = server.address() as AddressInfo;
    (service as unknown as { server: typeof server }).server = server;

    const inFlight = new Promise<number>((resolve) => {
      httpRequest({ port, path: '/v1/slow', agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }).end();
    });
    await sleep(100);
    const stopping = service.shutdown('SIGTERM', false);
    await sleep(50);
    const refused = await fetch(`http://127.0.0.1:${port}/health/live`).then(
      () => 'aceitou',
      () => 'recusou',
    );

    expect(await inFlight).toBe(200); // a requisição em andamento terminou
    await stopping;
    expect(refused).toBe('recusou');
    expect(closed).toEqual(['consumer', 'database']);
  });
});
