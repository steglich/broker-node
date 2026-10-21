import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  adapters,
  formatReport,
  loadScenarios,
  parseScenario,
  runScenario,
  ScenarioFormatError,
  type ScenarioAdapter,
} from '../src/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = (name: string) =>
  parseScenario(
    readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), 'utf8'),
    name,
  );

describe('cenários de referência (golden master)', () => {
  const scenarios = loadScenarios(root);

  it('carrega os cenários do repositório (e não as fixtures de teste)', () => {
    expect(scenarios.map((s) => s.id)).toEqual(['CAL-001', 'FEE-010']);
  });

  it.each(scenarios.map((s) => [s.title, s] as const))('%s', (_title, scenario) => {
    const result = runScenario(scenario, adapters);
    expect(result.error).toBeUndefined();
    expect(result.differences).toEqual([]);
  });
});

describe('runner', () => {
  it('um cenário falhando gera diff legível por caminho', () => {
    const result = runScenario(fixture('FEE-901.yaml'), adapters);
    expect(result.passed).toBe(false);
    expect(formatReport([result])).toBe(
      [
        '✗ FEE-901 rateio com resultado esperado errado  (FEE-901.yaml)',
        '  partes.b',
        '    esperado: "0.04"',
        '    obtido:   "0.03"',
        '',
        '0 passaram, 1 falharam',
      ].join('\n'),
    );
  });

  it('aponta campo ausente, sobrando e item de lista', () => {
    const scenario = parseScenario(
      'cenario: XYZ-001 t\nentradas: {}\nsaidas_esperadas: { a: 1, lista: [1, 2] }\n',
      'x.yaml',
    );
    const result = runScenario(scenario, { XYZ: () => ({ b: 2, lista: [1] }) });
    expect(result.differences).toEqual([
      { path: 'a', expected: 1, actual: expect.anything() },
      { path: 'lista[1]', expected: 2, actual: expect.anything() },
      { path: 'b', expected: expect.anything(), actual: 2 },
    ]);
    expect(formatReport([result])).toContain('    obtido:   (ausente)');
  });

  it('RN-QA-002: semente e relógio virtual do cenário chegam ao adaptador', () => {
    const probe: ScenarioAdapter = (_in, ctx) => ({
      agora: ctx.clock.now().toString(),
      sorteio: ctx.random.int(1, 1_000_000),
    });
    const yaml = (seed: number) =>
      `cenario: PRB-001 t\nsemente: ${seed}\nrelogio: "2026-03-02T12:00:00Z"\nentradas: {}\nsaidas_esperadas: {}\n`;
    const a = runScenario(parseScenario(yaml(7), 'a'), { PRB: probe });
    const b = runScenario(parseScenario(yaml(7), 'b'), { PRB: probe });
    const c = runScenario(parseScenario(yaml(8), 'c'), { PRB: probe });
    expect(a.differences).toEqual(b.differences);
    expect(a.differences.find((d) => d.path === 'agora')!.actual).toBe('2026-03-02T12:00:00.000Z');
    expect(c.differences.find((d) => d.path === 'sorteio')!.actual).not.toBe(
      a.differences.find((d) => d.path === 'sorteio')!.actual,
    );
  });

  it('rejeição do domínio vira { erro: CODE } e pode ser a saída esperada', () => {
    const scenario = parseScenario(
      'cenario: FEE-902 rateio sem itens\nentradas: { operacao: rateio, total: "1.00", itens: [] }\nsaidas_esperadas: { erro: INVALID_ALLOCATION }\n',
      'x.yaml',
    );
    expect(runScenario(scenario, adapters).passed).toBe(true);
  });

  it('erro inesperado e domínio sem adaptador reprovam com mensagem', () => {
    const noAdapter = parseScenario('cenario: ME-001 t\nentradas: {}\nsaidas_esperadas: {}\n', 'x');
    expect(runScenario(noAdapter, adapters).error).toBe('sem adaptador para o domínio ME');
  });

  it.each([
    ['sem cenario', 'entradas: {}\nsaidas_esperadas: {}\n', "falta 'cenario'"],
    ['sem ID', 'cenario: rateio\nentradas: {}\nsaidas_esperadas: {}\n', 'precisa começar pelo ID'],
    ['sem saídas', 'cenario: FEE-001 t\nentradas: {}\n', "falta 'saidas_esperadas'"],
    [
      'chave errada',
      'cenario: FEE-001 t\nentrada: {}\nentradas: {}\nsaidas_esperadas: {}\n',
      "chave desconhecida 'entrada'",
    ],
  ])('formato inválido: %s', (_name, source, message) => {
    expect(() => parseScenario(source, 'x.yaml')).toThrow(ScenarioFormatError);
    expect(() => parseScenario(source, 'x.yaml')).toThrow(message);
  });
});
