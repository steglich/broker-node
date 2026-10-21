import { allocate, Money } from '@broker/domain-kernel';
import type { ScenarioAdapter } from '../runner.js';

interface FeeInputs {
  operacao: 'rateio';
  total: string;
  itens: { id: string; peso: string }[];
}

/** Custos e tarifas (FEE-*). Hoje: rateio pelo maior resto (RN-FEE-031). */
export const feeAdapter: ScenarioAdapter = (raw) => {
  const inputs = raw as FeeInputs;
  switch (inputs.operacao) {
    case 'rateio': {
      const parts = allocate(
        Money.of(inputs.total, 'BRL'),
        inputs.itens.map((i) => ({ id: i.id, weight: i.peso })),
      );
      return { partes: Object.fromEntries([...parts].map(([id, m]) => [id, m.toString()])) };
    }
    default:
      throw new Error(`operação FEE desconhecida: ${String(inputs.operacao)}`);
  }
};
