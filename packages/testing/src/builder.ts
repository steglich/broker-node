import { seededRandom, type SeededRandom } from './random.js';

/** O que a função de padrões recebe: um contador por builder e um PRNG semeado (RN-QA-002). */
export interface BuildContext {
  /** 1, 2, 3… a cada objeto construído por este builder (zerado por `reset`). */
  readonly seq: number;
  readonly random: SeededRandom;
}

export interface Builder<T> {
  /** Um objeto válido com os padrões, sobrescritos campo a campo por `overrides`. */
  (overrides?: Partial<T>): T;
  many(count: number, overrides?: Partial<T>): T[];
  /** Volta o contador e a semente ao início (testes independentes da ordem de execução). */
  reset(): void;
}

/**
 * Fábrica de dados de teste (RN-QA-020): cada agregado ganha um builder com valores padrão
 * VÁLIDOS, e o teste só escreve o que importa para a regra que verifica.
 *
 *   const anOrder = defineBuilder<Order>(({ seq }) => ({ id: `order-${seq}`, side: 'BUY', ... }));
 *   anOrder({ side: 'SELL' });
 *
 * Os padrões são determinísticos: mesma semente, mesma sequência de objetos.
 */
export function defineBuilder<T>(defaults: (ctx: BuildContext) => T, seed = 1): Builder<T> {
  let seq = 0;
  let random = seededRandom(seed);
  const build = ((overrides: Partial<T> = {}) => {
    seq += 1;
    return { ...defaults({ seq, random }), ...overrides };
  }) as Builder<T>;
  build.many = (count, overrides) => Array.from({ length: count }, () => build(overrides));
  build.reset = () => {
    seq = 0;
    random = seededRandom(seed);
  };
  return build;
}
