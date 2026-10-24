import type { Questionnaire } from './suitability.js';

const opts = (...items: [string, number][]) =>
  items.map(([text, weight], i) => ({ id: String.fromCharCode(97 + i), text, weight }));

/**
 * Questionário v1 (RN-SUI-002): as oito perguntas mínimas. Pontuação máxima 45; faixas padrão
 * 0–15 conservador, 16–30 moderado, 31–45 arrojado (RN-SUI-003). Mudanças entram como nova versão.
 */
export const DEFAULT_QUESTIONNAIRE: Questionnaire = {
  version: 1,
  questions: [
    {
      id: 'objective',
      text: 'Qual é o principal objetivo do investimento?',
      options: opts(
        ['Preservar o capital', 0],
        ['Gerar renda complementar', 2],
        ['Crescer o patrimônio no longo prazo', 4],
        ['Maximizar o retorno, aceitando oscilações fortes', 6],
      ),
    },
    {
      id: 'horizon',
      text: 'Por quanto tempo pretende manter os investimentos?',
      options: opts(
        ['Menos de 1 ano', 0],
        ['De 1 a 3 anos', 2],
        ['De 3 a 5 anos', 4],
        ['Mais de 5 anos', 6],
      ),
    },
    {
      id: 'knowledge',
      text: 'Como avalia seu conhecimento sobre o mercado financeiro?',
      options: opts(['Nenhum', 0], ['Básico', 2], ['Intermediário', 4], ['Avançado', 6]),
    },
    {
      id: 'experience',
      text: 'Já investiu em renda variável (ações, FIIs, ETFs)?',
      options: opts(
        ['Nunca', 0],
        ['Há menos de 1 ano', 2],
        ['De 1 a 5 anos', 4],
        ['Há mais de 5 anos', 6],
      ),
    },
    {
      id: 'frequency',
      text: 'Com que frequência pretende operar?',
      options: opts(
        ['Raramente', 0],
        ['Algumas vezes por ano', 2],
        ['Mensalmente', 4],
        ['Toda semana ou mais', 6],
      ),
    },
    {
      id: 'loss_reaction',
      text: 'Se sua carteira cair 20% em um mês, você…',
      options: opts(
        ['Vende tudo', 0],
        ['Vende uma parte', 2],
        ['Mantém e espera', 4],
        ['Aproveita para comprar mais', 6],
      ),
    },
    {
      id: 'share',
      text: 'Que parte do seu patrimônio pretende investir aqui?',
      options: opts(['Até 10%', 0], ['De 10% a 25%', 2], ['De 25% a 50%', 4], ['Mais de 50%', 6]),
    },
    {
      id: 'liquidity',
      text: 'Pode precisar desse dinheiro de repente?',
      options: opts(
        ['Sim, a qualquer momento', 0],
        ['Talvez, em alguns meses', 1],
        ['Dificilmente', 2],
        ['Não', 3],
      ),
    },
  ],
  bands: [
    { profile: 'CONSERVATIVE', min: 0 },
    { profile: 'MODERATE', min: 16 },
    { profile: 'AGGRESSIVE', min: 31 },
  ],
};
