import { cpfCheckDigit } from '@broker/domain-kernel';
import { seededRandom, type SeededRandom } from './random.js';

/**
 * Cenários do simulador de KYC pelo penúltimo dígito do CPF (RN-ONB §5.2):
 * 0–6 APPROVED, 7 MANUAL_REVIEW (FACE_MATCH), 8 MANUAL_REVIEW (WATCHLIST), 9 REJECTED.
 */
export type KycScenarioDigit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface GenerateCpfOptions {
  /** Penúltimo dígito desejado (é o 1º dígito verificador). Sem ele, qualquer CPF válido. */
  penultimateDigit?: KycScenarioDigit;
  /** Fonte de aleatoriedade; use `seededRandom(seed)` para reprodutibilidade. */
  random?: SeededRandom;
}

/**
 * Gera um CPF válido (11 dígitos, sem máscara). O penúltimo dígito do CPF é o 1º dígito
 * verificador, então o gerador sorteia a base de 9 dígitos até o DV cair no valor pedido.
 */
export function generateCpf(options: GenerateCpfOptions = {}): string {
  const random = options.random ?? seededRandom(Date.now());
  for (;;) {
    let base = '';
    for (let i = 0; i < 9; i++) base += String(random.int(0, 9));
    if (/^(\d)\1{8}$/.test(base)) continue;
    const dv1 = cpfCheckDigit(base);
    if (options.penultimateDigit !== undefined && dv1 !== options.penultimateDigit) continue;
    return base + String(dv1) + String(cpfCheckDigit(base + String(dv1)));
  }
}
