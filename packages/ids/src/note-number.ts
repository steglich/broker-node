/**
 * Número da nota de corretagem (RN-NTC-002): sequencial por conta, exibido com 9 dígitos
 * (`000000042`). O ID global da nota é o `note_id` (UUID v7). O formato de exibição é decisão
 * da implementação, registrada no mapeamento tecnológico.
 */
export const NOTE_NUMBER_MAX = 999_999_999;

export function formatNoteNumber(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > NOTE_NUMBER_MAX) {
    throw new Error(`número de nota fora de 1..${NOTE_NUMBER_MAX}: ${sequence}`);
  }
  return String(sequence).padStart(9, '0');
}

export function parseNoteNumber(value: string): number {
  if (!/^\d{9}$/.test(value) || Number(value) < 1)
    throw new Error(`número de nota inválido: ${value}`);
  return Number(value);
}
