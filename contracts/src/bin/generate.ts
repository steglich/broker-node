/**
 * Gera `contracts/generated/` a partir dos contratos TypeBox (D8):
 *   events/<eventType>/v<N>.schema.json, asyncapi.json e openapi/<serviço>.json.
 *
 *   pnpm contracts:generate
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateArtifacts } from '../generate.js';
import { loadRegistry } from '../registry.js';
import { CONTRACTS_ROOT } from './paths.js';

const outDir = join(CONTRACTS_ROOT, 'generated');
const files = generateArtifacts(await loadRegistry(CONTRACTS_ROOT));
rmSync(outDir, { recursive: true, force: true });
for (const [path, content] of files) {
  mkdirSync(dirname(join(outDir, path)), { recursive: true });
  writeFileSync(join(outDir, path), content);
}
console.log(`${files.size} arquivo(s) em contracts/generated/`);
