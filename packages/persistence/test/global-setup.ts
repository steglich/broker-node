import { startPostgres } from '@broker/testing/containers';
import type { TestProject } from 'vitest/node';

/** Databases criados para os testes: um por arquivo, para isolar o estado. */
export const TEST_SERVICES = [
  'migrations',
  'unordered',
  'appendonly',
  'crypto',
  'leader',
  'calendar',
] as const;

export interface PostgresInfo {
  host: string;
  port: number;
  passwords: Record<string, string>;
  /** Superusuário do contêiner, só para os testes simularem falhas (ex.: derrubar uma sessão). */
  superuser: { user: string; password: string };
}

declare module 'vitest' {
  export interface ProvidedContext {
    postgres: PostgresInfo;
  }
}

/**
 * Sobe um PostgreSQL 17 real (Testcontainers) com o MESMO script de init do ambiente local.
 * Assim os testes usam as credenciais reais `<svc>_app` (DML) e `<svc>_migrator` (DDL).
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const pg = await startPostgres(TEST_SERVICES);
  project.provide('postgres', {
    host: pg.host,
    port: pg.port,
    passwords: pg.passwords,
    superuser: pg.superuser,
  });
  return async () => {
    await pg.container.stop();
  };
}
