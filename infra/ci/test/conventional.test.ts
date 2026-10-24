import { describe, expect, it } from 'vitest';
import {
  bumpFor,
  lintMessage,
  nextVersion,
  parseCommit,
  renderChangelog,
} from '../conventional.mjs';

const scopes = new Set(['pix-simulator', 'service-kit', 'webhooks', 'infra', 'ci']);
const commit = (message: string, hash = 'abcdef1234') => ({
  hash,
  message,
  parsed: parseCommit(message),
});

describe('convenção de commits (RN-CICD-021)', () => {
  it.each([
    'feat(pix-simulator): adiciona devolução parcial',
    'fix(service-kit,webhooks)!: troca o header de assinatura',
    'chore: atualiza dependências',
    'ci(ci): roda o gitleaks só no PR\n\nCorpo explicando o motivo.',
    'Merge pull request #3 from steglich/x',
  ])('aceita %j', (message) => {
    expect(lintMessage(message, scopes)).toEqual([]);
  });

  it.each([
    ['Fase 0, grupo 9: pipeline de CI', 'cabeçalho fora da convenção'],
    ['feature(pix-simulator): x', 'tipo desconhecido "feature"'],
    ['feat(pix): adiciona x', 'escopo desconhecido "pix"'],
    ['feat: termina com ponto.', 'não termina com ponto'],
    [`feat: ${'x'.repeat(100)}`, 'máximo 100'],
    ['feat: cabeçalho\ncorpo colado', 'linha em branco'],
  ])('recusa %j', (message, problem) => {
    expect(lintMessage(message, scopes).join(' ')).toContain(problem);
  });

  it('BREAKING CHANGE no corpo também marca quebra', () => {
    expect(
      parseCommit('refactor(service-kit): muda o contrato\n\nBREAKING CHANGE: route() exige auth'),
    ).toMatchObject({
      breaking: true,
      breakingNote: 'route() exige auth',
    });
  });
});

describe('versão semântica por serviço (RN-CICD-020)', () => {
  it.each([
    [['fix: a'], '1.2.3', 'patch', '1.2.4'],
    [['fix: a', 'feat: b'], '1.2.3', 'minor', '1.3.0'],
    [['feat!: c'], '1.2.3', 'major', '2.0.0'],
    [['feat!: c'], '0.4.1', 'minor', '0.5.0'],
    [['docs: d', 'chore: e', 'Fase 0, grupo 1: x'], '0.1.0', null, null],
  ] as const)('%j sobre %s → %s', (messages, version, bump, next) => {
    const b = bumpFor(
      messages.map((m) => commit(m)),
      version,
    );
    expect(b).toBe(bump);
    if (b) expect(nextVersion(version, b)).toBe(next);
  });

  it('o changelog agrupa por tipo e põe as quebras no topo', () => {
    const text = renderChangelog('0.2.0', '2026-10-24', [
      commit('feat(pix-simulator): adiciona devolução', '1111111aaa'),
      commit('fix(pix-simulator): corrige saldo', '2222222bbb'),
      commit(
        'feat(pix-simulator)!: renomeia valor\n\nBREAKING CHANGE: `valor` virou `amount`',
        '3333333ccc',
      ),
      commit('docs(pix-simulator): readme', '4444444ddd'),
    ]);
    expect(text).toBe(
      [
        '## 0.2.0 (2026-10-24)',
        '',
        '### Mudanças incompatíveis',
        '',
        '- `valor` virou `amount` (3333333)',
        '',
        '### Novidades',
        '',
        '- adiciona devolução (1111111)',
        '- renomeia valor (3333333)',
        '',
        '### Correções',
        '',
        '- corrige saldo (2222222)',
        '',
      ].join('\n'),
    );
  });
});
