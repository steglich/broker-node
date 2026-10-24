import type { DocumentProblem, Inspection } from './documents.js';

export type VerificationType =
  'TAX_ID_STATUS' | 'DOCUMENT_QUALITY' | 'FACE_MATCH' | 'WATCHLIST' | 'LIVENESS';
export type VerificationStatus = 'PASSED' | 'ATTENTION' | 'FAILED';

export interface Verification {
  type: VerificationType;
  status: VerificationStatus;
  score?: number;
  details: Record<string, unknown>;
}

/** Resultados forçáveis pela UI para a próxima submissão (RN-SIM-005). */
export type KycScenario =
  | 'FORCE_FACE_MATCH_LOW'
  | 'FORCE_WATCHLIST_HIT'
  | 'FORCE_TAX_ID_IRREGULAR'
  | 'FORCE_DOCUMENT_UNREADABLE';

export const KYC_SCENARIOS: ReadonlyArray<{ id: KycScenario; label: string }> = [
  {
    id: 'FORCE_FACE_MATCH_LOW',
    label: 'Próxima verificação: FACE_MATCH entre 50 e 79 (como o dígito 7)',
  },
  {
    id: 'FORCE_WATCHLIST_HIT',
    label: 'Próxima verificação: ocorrência em WATCHLIST (como o dígito 8)',
  },
  { id: 'FORCE_TAX_ID_IRREGULAR', label: 'Próxima verificação: CPF irregular (como o dígito 9)' },
  { id: 'FORCE_DOCUMENT_UNREADABLE', label: 'Próxima verificação: documento ilegível' },
];

const between = (random: () => number, min: number, max: number) =>
  min + Math.floor(random() * (max - min + 1));

/**
 * Regras determinísticas pelo PENÚLTIMO dígito do CPF (Onboarding §5.2):
 * 0–6 aprova tudo; 7 → FACE_MATCH 50–79; 8 → ocorrência em WATCHLIST; 9 → TAX_ID_STATUS irregular.
 * O penúltimo dígito é o 1º verificador, então o CPF continua válido (o gerador de teste escolhe).
 * DOCUMENT_QUALITY vem da leitura real dos documentos.
 */
export function decide(input: {
  taxId: string;
  documents: Array<{ type: string; result: Inspection | DocumentProblem }>;
  forced?: KycScenario | null;
  random: () => number;
}): Verification[] {
  const digit = Number(input.taxId[9]);
  const forced = input.forced ?? null;
  const irregular = digit === 9 || forced === 'FORCE_TAX_ID_IRREGULAR';
  const lowFace = digit === 7 || forced === 'FORCE_FACE_MATCH_LOW';
  const watchlist = digit === 8 || forced === 'FORCE_WATCHLIST_HIT';

  const problem =
    forced === 'FORCE_DOCUMENT_UNREADABLE'
      ? { type: input.documents[0]?.type ?? 'ID_FRONT', reason: 'UNSUPPORTED_FORMAT' }
      : input.documents
          .filter((d) => typeof d.result === 'string')
          .map((d) => ({ type: d.type, reason: d.result as DocumentProblem }))[0];

  const faceScore = lowFace ? between(input.random, 50, 79) : between(input.random, 85, 99);
  return [
    irregular
      ? { type: 'TAX_ID_STATUS', status: 'FAILED', details: { situation: 'IRREGULAR' } }
      : { type: 'TAX_ID_STATUS', status: 'PASSED', details: { situation: 'REGULAR' } },
    problem
      ? {
          type: 'DOCUMENT_QUALITY',
          status: 'FAILED',
          details: { document: problem.type, reason: problem.reason },
        }
      : {
          type: 'DOCUMENT_QUALITY',
          status: 'PASSED',
          details: {
            documents: input.documents.map((d) => ({ type: d.type, ...(d.result as Inspection) })),
          },
        },
    // RN-ONB-020: ≥ 80 aprova, 50–79 revisão manual, < 50 reprova.
    {
      type: 'FACE_MATCH',
      status: faceScore >= 80 ? 'PASSED' : 'ATTENTION',
      score: faceScore,
      details: {},
    },
    watchlist
      ? { type: 'WATCHLIST', status: 'ATTENTION', details: { hit: true, lists: ['PEP'] } }
      : { type: 'WATCHLIST', status: 'PASSED', details: { hit: false } },
    { type: 'LIVENESS', status: 'PASSED', score: between(input.random, 90, 99), details: {} },
  ];
}
