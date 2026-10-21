/** Uma diferença entre o esperado e o obtido, apontada por caminho (`resultados.d1`, `partes[2]`). */
export interface Difference {
  path: string;
  expected: unknown;
  actual: unknown;
}

const MISSING = Symbol('ausente');
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Diferenças estruturais, campo a campo. Igualdade exata: sem conversão de tipo. */
export function diff(expected: unknown, actual: unknown, path = ''): Difference[] {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const out: Difference[] = [];
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      out.push(
        ...diff(
          i < expected.length ? expected[i] : MISSING,
          i < actual.length ? actual[i] : MISSING,
          `${path}[${i}]`,
        ),
      );
    }
    return out;
  }
  if (isObject(expected) && isObject(actual)) {
    const out: Difference[] = [];
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      out.push(
        ...diff(
          key in expected ? expected[key] : MISSING,
          key in actual ? actual[key] : MISSING,
          path ? `${path}.${key}` : key,
        ),
      );
    }
    return out;
  }
  return Object.is(expected, actual) ? [] : [{ path: path || '(raiz)', expected, actual }];
}

const show = (v: unknown) => (v === MISSING ? '(ausente)' : JSON.stringify(v));

/** Diff legível, uma linha por diferença. */
export function formatDiff(differences: readonly Difference[]): string {
  return differences
    .map((d) => `  ${d.path}\n    esperado: ${show(d.expected)}\n    obtido:   ${show(d.actual)}`)
    .join('\n');
}
