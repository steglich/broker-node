import Type from 'typebox';
import { defineHttpContract } from '../src/define.js';

const Uuid = Type.String({ format: 'uuid' });
const Date_ = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const Money = Type.String({ pattern: '^\\d{1,16}(\\.\\d{1,2})?$' });
const Code6 = Type.String({ pattern: '^\\d{6}$' });
const Reason = Type.Object({ reason: Type.String({ minLength: 3, maxLength: 500 }) });
const ok204 = { 204: { description: 'Feito.' } };

export const Address = Type.Object({
  zipCode: Type.String({ maxLength: 8 }),
  street: Type.String({ maxLength: 200 }),
  number: Type.String({ maxLength: 20 }),
  complement: Type.Optional(Type.String({ maxLength: 100 })),
  district: Type.String({ maxLength: 100 }),
  city: Type.String({ maxLength: 100 }),
  state: Type.String({ maxLength: 2 }),
});

export const IdDocument = Type.Object({
  type: Type.Union([Type.Literal('RG'), Type.Literal('CNH'), Type.Literal('RNE')]),
  number: Type.String({ maxLength: 30 }),
  issuer: Type.String({ maxLength: 30 }),
  issuerState: Type.String({ maxLength: 2 }),
  issueDate: Date_,
});

export const PersonalData = Type.Object({
  fullName: Type.String({ maxLength: 200 }),
  socialName: Type.Optional(Type.String({ maxLength: 200 })),
  taxId: Type.String({ maxLength: 14 }),
  birthDate: Date_,
  nationality: Type.Union([Type.Literal('BRAZILIAN'), Type.Literal('FOREIGN_RESIDENT')]),
  maritalStatus: Type.Union(
    ['SINGLE', 'MARRIED', 'STABLE_UNION', 'DIVORCED', 'WIDOWED', 'SEPARATED'].map((s) =>
      Type.Literal(s),
    ),
  ),
  motherName: Type.String({ maxLength: 200 }),
  gender: Type.Optional(Type.String({ maxLength: 50 })),
  idDocument: IdDocument,
});

export const FinancialProfile = Type.Object({
  occupation: Type.String({ maxLength: 40 }),
  monthlyIncome: Money,
  declaredNetWorth: Money,
  pep: Type.Boolean(),
  linkedPerson: Type.Boolean(),
  fundsOrigin: Type.String({ maxLength: 200 }),
  foreignTaxResidency: Type.Boolean(),
});

const DocumentType = Type.Union(
  ['ID_FRONT', 'ID_BACK', 'PROOF_OF_ADDRESS', 'SELFIE'].map((t) => Type.Literal(t)),
);

export const customerServiceHttp = defineHttpContract({
  service: 'customer-service',
  title: 'customer-service',
  version: '1.0.0',
  routes: {
    onboarding: {
      method: 'get',
      path: '/v1/me/onboarding',
      summary: 'Estado da solicitação, próxima etapa e rascunho salvo (RN-ONB-001).',
      auth: 'user',
      responses: { 200: { description: 'Solicitação.' } },
    },
    contact: {
      method: 'put',
      path: '/v1/me/onboarding/contact',
      summary: 'E-mail e celular; envia um código para cada.',
      auth: 'user',
      body: Type.Object({
        email: Type.String({ maxLength: 254 }),
        phone: Type.String({ maxLength: 16 }),
      }),
      responses: { ...ok204, 422: { description: 'EMAIL_ALREADY_IN_USE.' } },
    },
    verifyContact: {
      method: 'post',
      path: '/v1/me/onboarding/contact/verify',
      summary: 'Confirma os códigos do e-mail e do celular (CONTACT_VERIFIED).',
      auth: 'user',
      body: Type.Object({ emailCode: Code6, phoneCode: Code6 }),
      responses: ok204,
    },
    personalData: {
      method: 'put',
      path: '/v1/me/onboarding/personal-data',
      summary: 'Dados pessoais (Onboarding §4.1).',
      auth: 'user',
      body: PersonalData,
      responses: { ...ok204, 422: { description: 'UNDERAGE ou TAX_ID_ALREADY_REGISTERED.' } },
    },
    address: {
      method: 'put',
      path: '/v1/me/onboarding/address',
      summary: 'Endereço (Onboarding §4.2).',
      auth: 'user',
      body: Address,
      responses: ok204,
    },
    financialProfile: {
      method: 'put',
      path: '/v1/me/onboarding/financial-profile',
      summary: 'Perfil financeiro, PEP e residência fiscal (Onboarding §4.3).',
      auth: 'user',
      body: FinancialProfile,
      responses: ok204,
    },
    uploadUrl: {
      method: 'post',
      path: '/v1/me/onboarding/documents/upload-url',
      summary: 'URL pré-assinada para enviar um documento direto ao storage.',
      auth: 'user',
      body: Type.Object({
        type: DocumentType,
        contentType: Type.String({ maxLength: 100 }),
        sizeBytes: Type.Integer({ minimum: 1 }),
      }),
      responses: {
        201: {
          description: 'URL de upload.',
          body: Type.Object({
            documentId: Uuid,
            uploadUrl: Type.String(),
            expiresAt: Type.String({ format: 'date-time' }),
          }),
        },
        422: { description: 'DOCUMENT_INVALID_FORMAT (tipo ou mais de 10 MB).' },
      },
    },
    registerDocument: {
      method: 'post',
      path: '/v1/me/onboarding/documents',
      summary: 'Registra o documento enviado: tipo pelo conteúdo, tamanho e resolução.',
      auth: 'user',
      body: Type.Object({ documentId: Uuid }),
      responses: {
        200: { description: 'Aceito.' },
        422: { description: 'DOCUMENT_INVALID_FORMAT.' },
      },
    },
    submit: {
      method: 'post',
      path: '/v1/me/onboarding/submit',
      summary: 'Submete a solicitação ao KYC simulado (UNDER_REVIEW).',
      auth: 'user',
      responses: { 202: { description: 'Em análise.' } },
    },
    kycWebhook: {
      method: 'post',
      path: '/webhooks/kyc-simulator',
      summary: 'Webhook assinado do KYC simulado (check.verification_completed e check.completed).',
      auth: 'public',
      responses: {
        204: { description: 'Recebido.' },
        401: { description: 'INVALID_WEBHOOK_SIGNATURE.' },
      },
    },
    questionnaire: {
      method: 'get',
      path: '/v1/suitability/questionnaire',
      summary: 'Questionário vigente (RN-SUI-001).',
      auth: 'user',
      responses: { 200: { description: 'Questionário.' } },
    },
    assess: {
      method: 'post',
      path: '/v1/me/suitability/assessments',
      summary: 'Responde o questionário: pontuação, perfil e validade de 24 meses.',
      auth: 'user',
      body: Type.Object({
        questionnaireVersion: Type.Integer({ minimum: 1 }),
        answers: Type.Record(Type.String(), Type.String()),
      }),
      responses: { 201: { description: 'Perfil.' } },
    },
    pendingTerms: {
      method: 'get',
      path: '/v1/me/terms/pending',
      summary: 'Termos vigentes ainda sem aceite.',
      auth: 'user',
      responses: { 200: { description: 'Termos.' } },
    },
    acceptTerms: {
      method: 'post',
      path: '/v1/me/terms/:termsId/accept',
      summary: 'Aceite com hash do conteúdo, IP, user agent e canal (RN-TER-002).',
      auth: 'user',
      params: Type.Object({ termsId: Uuid }),
      body: Type.Object({ version: Type.Integer({ minimum: 1 }) }),
      responses: ok204,
    },
    profile: {
      method: 'get',
      path: '/v1/me/profile',
      summary: 'Cadastro, conta (status e permissões), perfil e termos pendentes.',
      auth: 'user',
      responses: { 200: { description: 'Perfil.' } },
    },
    contactChange: {
      method: 'post',
      path: '/v1/me/profile/contact-changes',
      summary:
        'Troca de e-mail, celular ou endereço: assinatura (SETTINGS) + OTP no canal antigo e no novo (RN-CAD-001).',
      auth: 'user',
      body: Type.Object({
        kind: Type.Union([Type.Literal('EMAIL'), Type.Literal('PHONE'), Type.Literal('ADDRESS')]),
        email: Type.Optional(Type.String({ maxLength: 254 })),
        phone: Type.Optional(Type.String({ maxLength: 16 })),
        address: Type.Optional(Address),
      }),
      responses: {
        202: { description: 'Códigos enviados.', body: Type.Object({ changeId: Uuid }) },
      },
    },
    confirmContactChange: {
      method: 'post',
      path: '/v1/me/profile/contact-changes/:changeId/confirm',
      summary: 'Confirma com os dois códigos.',
      auth: 'user',
      params: Type.Object({ changeId: Uuid }),
      body: Type.Object({ oldCode: Code6, newCode: Code6 }),
      responses: ok204,
    },
    reviewedChange: {
      method: 'post',
      path: '/v1/me/profile/reviewed-changes',
      summary: 'Troca de nome ou documento: novo documento + revisão manual (RN-CAD-002).',
      auth: 'user',
      body: Type.Object({
        kind: Type.Union([Type.Literal('NAME'), Type.Literal('ID_DOCUMENT')]),
        fullName: Type.Optional(Type.String({ maxLength: 200 })),
        idDocument: Type.Optional(IdDocument),
      }),
      responses: { 202: { description: 'Pendente de revisão; URL para o documento.' } },
    },
    confirmRegistration: {
      method: 'post',
      path: '/v1/me/profile/confirm',
      summary: 'Confirma que o cadastro está atualizado: mais 24 meses (RN-CAD-003).',
      auth: 'user',
      responses: { 200: { description: 'Nova validade.' } },
    },
    history: {
      method: 'get',
      path: '/v1/me/profile/history',
      summary: 'Histórico de alterações cadastrais (RN-CAD-004).',
      auth: 'user',
      responses: { 200: { description: 'Histórico.' } },
    },
    withdrawalAccounts: {
      method: 'get',
      path: '/v1/me/withdrawal-accounts',
      summary: 'Contas de saque (chave mascarada, carência).',
      auth: 'user',
      responses: { 200: { description: 'Contas.' } },
    },
    addWithdrawalAccount: {
      method: 'post',
      path: '/v1/me/withdrawal-accounts',
      summary:
        'Cadastra chave PIX de mesma titularidade (até 3, carência de 24 h); assinatura e MFA recente.',
      auth: 'user',
      body: Type.Object({ pixKey: Type.String({ minLength: 1, maxLength: 77 }) }),
      responses: {
        201: { description: 'Cadastrada.' },
        422: { description: 'BANK_ACCOUNT_NOT_ALLOWED ou WITHDRAWAL_ACCOUNT_LIMIT.' },
      },
    },
    removeWithdrawalAccount: {
      method: 'delete',
      path: '/v1/me/withdrawal-accounts/:id',
      summary: 'Remove uma conta de saque (assinatura).',
      auth: 'user',
      params: Type.Object({ id: Uuid }),
      responses: ok204,
    },
    closeAccount: {
      method: 'post',
      path: '/v1/me/account/close',
      summary: 'Encerramento: lista as pendências ou encerra (RN-ACC-012).',
      auth: 'user',
      responses: {
        200: { description: 'Encerrada.' },
        422: { description: 'ACCOUNT_CLOSURE_PENDING com a lista.' },
      },
    },
    cancelClose: {
      method: 'post',
      path: '/v1/me/account/close/cancel',
      summary: 'Desiste do encerramento.',
      auth: 'user',
      responses: { 200: { description: 'Ativa.' } },
    },
    reviewQueue: {
      method: 'get',
      path: '/v1/bo/onboarding/queue',
      summary: 'Fila de revisão manual (BO_ONBOARDING, BO_ADMIN).',
      auth: 'user',
      responses: { 200: { description: 'Fila.' } },
    },
    approve: {
      method: 'post',
      path: '/v1/bo/onboarding/:id/approve',
      summary: 'Aprova (PEP só com BO_ADMIN).',
      auth: 'user',
      params: Type.Object({ id: Uuid }),
      body: Reason,
      responses: { 200: { description: 'Aprovada.' } },
    },
    reject: {
      method: 'post',
      path: '/v1/bo/onboarding/:id/reject',
      summary: 'Reprova.',
      auth: 'user',
      params: Type.Object({ id: Uuid }),
      body: Reason,
      responses: { 200: { description: 'Reprovada.' } },
    },
    requestChanges: {
      method: 'post',
      path: '/v1/bo/onboarding/:id/request-changes',
      summary: 'Pede correção ao cliente (PENDING_CUSTOMER).',
      auth: 'user',
      params: Type.Object({ id: Uuid }),
      body: Reason,
      responses: { 200: { description: 'Devolvida.' } },
    },
    block: {
      method: 'post',
      path: '/v1/bo/accounts/:id/block',
      summary: 'Bloqueio total (BO_RISK, BO_FINANCE, BO_ADMIN; RN-ACC-011).',
      auth: 'user',
      params: Type.Object({ id: Uuid }),
      body: Type.Object({ reasonCode: Type.String({ pattern: '^[A-Z][A-Z0-9_]{2,40}$' }) }),
      responses: { 200: { description: 'Bloqueada.' } },
    },
    unblock: {
      method: 'post',
      path: '/v1/bo/accounts/:id/unblock',
      summary: 'Desbloqueio (BO_ADMIN; a dupla aprovação vem com o approval-service).',
      auth: 'user',
      params: Type.Object({ id: Uuid }),
      body: Type.Object({ reasonCode: Type.String({ pattern: '^[A-Z][A-Z0-9_]{2,40}$' }) }),
      responses: { 200: { description: 'Desbloqueada.' } },
    },
    publishTerms: {
      method: 'post',
      path: '/v1/bo/terms/:code/versions',
      summary: 'Nova versão de um termo (BO_ADMIN).',
      auth: 'user',
      params: Type.Object({ code: Type.String({ pattern: '^[A-Z_]{3,40}$' }) }),
      body: Type.Object({
        title: Type.String({ maxLength: 200 }),
        content: Type.String({ minLength: 10 }),
      }),
      responses: { 201: { description: 'Publicada.' } },
    },
    profileChanges: {
      method: 'get',
      path: '/v1/bo/profile-changes',
      summary: 'Trocas de nome e documento à espera de revisão.',
      auth: 'user',
      responses: { 200: { description: 'Fila.' } },
    },
    reviewProfileChange: {
      method: 'post',
      path: '/v1/bo/profile-changes/:id/:decision',
      summary: 'Aprova ou reprova a troca (BO_ONBOARDING).',
      auth: 'user',
      params: Type.Object({
        id: Uuid,
        decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')]),
      }),
      responses: ok204,
    },
    eligibility: {
      method: 'get',
      path: '/v1/internal/accounts/:id/eligibility',
      summary:
        'Elegibilidade de uma operação: matriz de status, termos pendentes e suitability (token de serviço com customer:eligibility).',
      auth: 'service',
      params: Type.Object({ id: Uuid }),
      query: Type.Object({
        operation: Type.Union(
          ['BUY', 'SELL', 'DEPOSIT', 'WITHDRAW', 'LOGIN'].map((o) => Type.Literal(o)),
        ),
      }),
      responses: { 200: { description: '{ allowed, code?, status, restrictions }' } },
    },
    holderMatch: {
      method: 'post',
      path: '/v1/internal/accounts/:id/holder-match',
      summary:
        'O CPF é o do titular da conta? Para o depósito do ledger (RN-DEP-003); token de serviço com customer:holder.',
      auth: 'service',
      params: Type.Object({ id: Uuid }),
      body: Type.Object({ taxId: Type.String({ maxLength: 14 }) }),
      responses: {
        200: { description: 'Resultado.', body: Type.Object({ matches: Type.Boolean() }) },
        404: { description: 'Conta inexistente.' },
      },
    },
    withdrawalDestination: {
      method: 'get',
      path: '/v1/internal/accounts/:id/withdrawal-accounts/:withdrawalAccountId',
      summary:
        'Destino do saque com a chave em claro e o CPF do titular (RN-SAQ-002); token de serviço com customer:withdrawal-accounts.',
      auth: 'service',
      params: Type.Object({ id: Uuid, withdrawalAccountId: Uuid }),
      responses: {
        200: {
          description: 'Conta de saque.',
          body: Type.Object({
            id: Uuid,
            status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('REMOVED')]),
            pixKey: Type.String(),
            pixKeyType: Type.String(),
            availableFrom: Type.String({ format: 'date-time' }),
            available: Type.Boolean(),
            holderTaxId: Type.String(),
          }),
        },
        404: { description: 'Inexistente ou de outra conta.' },
      },
    },
  },
});

export default customerServiceHttp;
