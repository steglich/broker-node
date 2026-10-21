import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';

/**
 * Um cenário de referência (estratégia de testes §3). O arquivo é YAML puro, sem nada de
 * TypeScript, para que qualquer implementação, em qualquer linguagem, rode os mesmos cenários.
 *
 *   cenario: FEE-010 rateio com resíduo de centavos   # ID + descrição; o prefixo escolhe o domínio
 *   regras: [RN-FEE-031]                              # opcional: regras cobertas (RN-QA-001)
 *   semente: 42                                       # opcional (padrão 1): PRNG do cenário
 *   relogio: 2026-01-05T13:00:00Z                     # opcional: início do relógio virtual
 *   entradas: { ... }                                 # livre, definido pelo domínio
 *   saidas_esperadas: { ... }                         # comparado por igualdade exata
 *
 * Valores decimais vão SEMPRE entre aspas ("0.10"): YAML leria 0.10 como número binário (ADR-0004).
 */
export interface Scenario {
  /** ID (`FEE-010`), extraído de `cenario`. */
  id: string;
  /** Prefixo do ID (`FEE`): escolhe o adaptador de domínio. */
  domain: string;
  title: string;
  rules: string[];
  seed: number;
  clockStart: string;
  inputs: unknown;
  expected: unknown;
  /** Caminho do arquivo, relativo à pasta carregada. */
  file: string;
}

export const DEFAULT_CLOCK_START = '2026-01-05T13:00:00Z';
const ID = /^([A-Z]+)-(\d{3})(?:[a-z])?\b/;

export class ScenarioFormatError extends Error {}

export function parseScenario(source: string, file: string): Scenario {
  const doc = parse(source) as Record<string, unknown> | null;
  const fail = (msg: string): never => {
    throw new ScenarioFormatError(`${file}: ${msg}`);
  };
  if (!doc || typeof doc !== 'object') fail('o arquivo não é um mapa YAML');
  const header = doc!['cenario'];
  if (typeof header !== 'string') fail("falta 'cenario' (ID e descrição)");
  const match =
    ID.exec(header as string) ??
    fail(`'cenario' precisa começar pelo ID (ex.: FEE-010): ${header}`);
  for (const key of ['entradas', 'saidas_esperadas']) if (!(key in doc!)) fail(`falta '${key}'`);
  const known = new Set([
    'cenario',
    'regras',
    'semente',
    'relogio',
    'entradas',
    'saidas_esperadas',
  ]);
  for (const key of Object.keys(doc!)) if (!known.has(key)) fail(`chave desconhecida '${key}'`);
  const seed = doc!['semente'] ?? 1;
  if (!Number.isSafeInteger(seed)) fail("'semente' precisa ser inteiro");
  const rules = doc!['regras'] ?? [];
  if (!Array.isArray(rules)) fail("'regras' precisa ser lista");
  return {
    id: (header as string).split(/\s/)[0]!,
    domain: match[1]!,
    title: header as string,
    rules: rules as string[],
    seed: seed as number,
    clockStart: String(doc!['relogio'] ?? DEFAULT_CLOCK_START),
    inputs: doc!['entradas'],
    expected: doc!['saidas_esperadas'],
    file,
  };
}

/** Carrega todos os `*.yaml` de `dir` (recursivo), em ordem de caminho. */
export function loadScenarios(dir: string): Scenario[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (
        entry.isDirectory() &&
        entry.name !== 'node_modules' &&
        entry.name !== 'src' &&
        entry.name !== 'test'
      )
        walk(full);
      else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) files.push(full);
    }
  };
  walk(dir);
  return files.sort().map((f) => parseScenario(readFileSync(f, 'utf8'), relative(dir, f)));
}
