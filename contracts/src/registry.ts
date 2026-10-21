import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EventContract, HttpContract } from './define.js';

export interface Registry {
  events: EventContract[];
  http: HttpContract[];
}

const VERSION_FILE = /^v([1-9]\d*)\.(ts|js)$/;

/**
 * Carrega os contratos de `contracts/events/<eventType>/v<N>.ts` e `contracts/http/<serviço>.ts`.
 * Confere que o nome da pasta e do arquivo batem com `eventType` e `eventVersion` da definição,
 * para o caminho no registro nunca mentir sobre o conteúdo.
 */
export async function loadRegistry(root: string): Promise<Registry> {
  const events: EventContract[] = [];
  for (const eventType of readdirSync(join(root, 'events')).sort()) {
    for (const file of readdirSync(join(root, 'events', eventType)).sort()) {
      if (file.endsWith('.d.ts')) continue;
      const match = VERSION_FILE.exec(file);
      if (!match) throw new Error(`arquivo fora do padrão v<N>.ts: events/${eventType}/${file}`);
      const contract = await importDefault<EventContract>(join(root, 'events', eventType, file));
      const { definition } = contract;
      if (definition.eventType !== eventType || definition.eventVersion !== Number(match[1])) {
        throw new Error(
          `events/${eventType}/${file} define ${definition.eventType} v${definition.eventVersion}`,
        );
      }
      events.push(contract);
    }
  }
  const http: HttpContract[] = [];
  for (const file of readdirSync(join(root, 'http')).sort()) {
    if (file.endsWith('.d.ts') || !/\.(ts|js)$/.test(file)) continue;
    const contract = await importDefault<HttpContract>(join(root, 'http', file));
    if (`${contract.service}.ts` !== file.replace(/\.js$/, '.ts')) {
      throw new Error(`http/${file} define o serviço ${contract.service}`);
    }
    http.push(contract);
  }
  return { events, http };
}

async function importDefault<T>(path: string): Promise<T> {
  const module = (await import(pathToFileURL(path).href)) as { default?: T };
  if (!module.default) throw new Error(`${path} não exporta o contrato como default`);
  return module.default;
}
