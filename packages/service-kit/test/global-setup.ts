import { startPostgres, startValkey } from '@broker/testing/containers';
import type { TestProject } from 'vitest/node';

export const TEST_SERVICES = ['kit', 'saga', 'paging', 'flags'] as const;

export interface KitInfra {
  postgres: { host: string; port: number; passwords: Record<string, string> };
  valkey: { host: string; port: number };
}

declare module 'vitest' {
  export interface ProvidedContext {
    kit: KitInfra;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [pg, valkey] = await Promise.all([startPostgres(TEST_SERVICES), startValkey()]);
  project.provide('kit', {
    postgres: { host: pg.host, port: pg.port, passwords: pg.passwords },
    valkey: { host: valkey.host, port: valkey.port },
  });
  return async () => {
    await Promise.all([pg.container.stop(), valkey.container.stop()]);
  };
}
