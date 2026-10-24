// API do provedor de KYC simulado (Sistemas simulados §3, Onboarding §5). Documentada como API de
// TERCEIRO (RN-SIM-001), num estilo diferente do Banco Simulado (snake_case, em inglês), como seria
// com dois fornecedores reais. O adaptador do núcleo traduz para `kyc_check` (RN-ONB-022).
import Type from 'typebox';
import { defineHttpContract } from '../src/define.js';

export const VerificationType = Type.Union([
  Type.Literal('TAX_ID_STATUS'),
  Type.Literal('DOCUMENT_QUALITY'),
  Type.Literal('FACE_MATCH'),
  Type.Literal('WATCHLIST'),
  Type.Literal('LIVENESS'),
]);

/** `ATTENTION` pede revisão humana (ex.: FACE_MATCH 50–79, ocorrência em WATCHLIST). */
export const VerificationStatus = Type.Union([
  Type.Literal('PASSED'),
  Type.Literal('ATTENTION'),
  Type.Literal('FAILED'),
]);

export const Verification = Type.Object({
  type: VerificationType,
  status: VerificationStatus,
  /** 0–100 quando a verificação tem score (FACE_MATCH, LIVENESS). */
  score: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  details: Type.Record(Type.String(), Type.Unknown()),
});

export const SubmitCheck = Type.Object({
  /** ID do cliente no sistema de quem contrata (o provedor só devolve). */
  reference_id: Type.String({ minLength: 1, maxLength: 100 }),
  tax_id: Type.String({ pattern: '^\\d{11}$' }),
  full_name: Type.String({ minLength: 1, maxLength: 120 }),
  birth_date: Type.String({ format: 'date' }),
  /**
   * Referências TEMPORÁRIAS e ASSINADAS (URL pré-assinada do storage de quem contrata). O provedor
   * lê uma vez, analisa em memória e não guarda cópia (RN-KYCS-001). URL sem assinatura é recusada.
   */
  documents: Type.Array(
    Type.Object({
      type: Type.Union([Type.Literal('ID_FRONT'), Type.Literal('ID_BACK'), Type.Literal('SELFIE')]),
      url: Type.String({ format: 'uri', maxLength: 4096 }),
    }),
    { minItems: 1, maxItems: 5 },
  ),
});

export const Check = Type.Object({
  check_id: Type.String({ format: 'uuid' }),
  reference_id: Type.String(),
  status: Type.Union([Type.Literal('PROCESSING'), Type.Literal('COMPLETED')]),
  verifications: Type.Array(Verification),
  created_at: Type.String({ format: 'date-time' }),
  completed_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

/** Webhook `check.verification_completed`: um por verificação (assinado, RN-SIM-003). */
export const VerificationWebhook = Type.Object({
  check_id: Type.String({ format: 'uuid' }),
  reference_id: Type.String(),
  verification: Verification,
});

/** Webhook `check.completed`: o fim da análise, com todas as verificações. */
export const CheckCompletedWebhook = Type.Object({
  check_id: Type.String({ format: 'uuid' }),
  reference_id: Type.String(),
  verifications: Type.Array(Verification),
});

export const kycSimulatorHttp = defineHttpContract({
  service: 'kyc-simulator',
  title: 'Provedor de KYC simulado',
  version: '1.0.0',
  routes: {
    submitCheck: {
      method: 'post',
      path: '/v1/checks',
      summary: 'Submete uma verificação; o resultado chega depois, por webhook.',
      auth: 'public',
      body: SubmitCheck,
      responses: {
        202: {
          description: 'Aceita para análise.',
          body: Type.Object({
            check_id: Type.String({ format: 'uuid' }),
            status: Type.Literal('PROCESSING'),
          }),
        },
        422: { description: 'DOCUMENT_URL_NOT_SIGNED: referência de documento sem assinatura.' },
      },
    },
    getCheck: {
      method: 'get',
      path: '/v1/checks/:check_id',
      summary: 'Consulta uma verificação.',
      auth: 'public',
      params: Type.Object({ check_id: Type.String({ format: 'uuid' }) }),
      responses: {
        200: { description: 'A verificação.', body: Check },
        404: { description: 'Inexistente.' },
      },
    },
  },
});

export default kycSimulatorHttp;
