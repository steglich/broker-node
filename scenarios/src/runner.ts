import type { VirtualClock } from '@broker/clock';
import { testClock, seededRandom, type SeededRandom } from '@broker/testing';
import { diff, formatDiff, type Difference } from './diff.js';
import type { Scenario } from './format.js';

/** O que o adaptador recebe além das entradas: o tempo e o acaso do cenário, sempre controlados. */
export interface ScenarioContext {
  clock: VirtualClock;
  random: SeededRandom;
}

/**
 * Adaptador de domínio: traduz as `entradas` do YAML em chamadas ao domínio puro e devolve as
 * saídas no mesmo formato de `saidas_esperadas`. Um por prefixo de ID (ME, ORD, FEE, CAL…).
 */
export type ScenarioAdapter = (inputs: unknown, ctx: ScenarioContext) => unknown;

export interface ScenarioResult {
  scenario: Scenario;
  passed: boolean;
  differences: Difference[];
  /** Erro inesperado do adaptador (não é um `erro` esperado pelo cenário). */
  error?: string;
}

/**
 * Executa um cenário. Uma regra rejeitada pelo domínio (erro com `code`, ex.: `DomainError`) vira
 * `{ erro: CODE }`, para o cenário poder esperar a rejeição como saída.
 */
export function runScenario(
  scenario: Scenario,
  adapters: Readonly<Record<string, ScenarioAdapter>>,
): ScenarioResult {
  const adapter = adapters[scenario.domain];
  if (!adapter) {
    return {
      scenario,
      passed: false,
      differences: [],
      error: `sem adaptador para o domínio ${scenario.domain}`,
    };
  }
  let actual: unknown;
  try {
    actual = adapter(scenario.inputs, {
      clock: testClock(scenario.clockStart),
      random: seededRandom(scenario.seed),
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code !== 'string') {
      return {
        scenario,
        passed: false,
        differences: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
    actual = { erro: code };
  }
  // Normaliza pelo JSON: o golden master compara dados, não instâncias (Money, BusinessDate…).
  const differences = diff(scenario.expected, JSON.parse(JSON.stringify(actual ?? null)));
  return { scenario, passed: differences.length === 0, differences };
}

export function runAll(
  scenarios: readonly Scenario[],
  adapters: Readonly<Record<string, ScenarioAdapter>>,
): ScenarioResult[] {
  return scenarios.map((s) => runScenario(s, adapters));
}

/** Relatório de texto: ✓/✗ por cenário e o diff dos que falharam. */
export function formatReport(results: readonly ScenarioResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.passed ? '✓' : '✗'} ${r.scenario.title}  (${r.scenario.file})`);
    if (r.error) lines.push(`  erro: ${r.error}`);
    if (r.differences.length > 0) lines.push(formatDiff(r.differences));
  }
  const failed = results.filter((r) => !r.passed).length;
  lines.push('', `${results.length - failed} passaram, ${failed} falharam`);
  return lines.join('\n');
}
