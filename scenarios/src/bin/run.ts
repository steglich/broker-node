/**
 * Roda os cenários de referência (golden master) e imprime o diff dos que falharem.
 *
 *   pnpm scenarios [FEE-010 CAL ...]   # filtra por ID ou prefixo; sem filtro, roda todos
 */
import { fileURLToPath } from 'node:url';
import { adapters } from '../adapters/index.js';
import { loadScenarios } from '../format.js';
import { formatReport, runAll } from '../runner.js';

const filters = process.argv.slice(2).filter((a) => a !== '--');
const all = loadScenarios(fileURLToPath(new URL('../../', import.meta.url)));
const selected =
  filters.length === 0 ? all : all.filter((s) => filters.some((f) => s.id === f || s.domain === f));
const results = runAll(selected, adapters);
console.log(formatReport(results));
if (selected.length === 0 || results.some((r) => !r.passed)) process.exitCode = 1;
