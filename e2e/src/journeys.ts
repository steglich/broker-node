// Jornadas do cliente pela borda, como o app faria (Onboarding §3–§5, Financeiro §2/§7). Cada
// passo é retomável: rodar de novo continua de onde a conta está, então as mesmas jornadas servem
// ao E2E e às sementes idempotentes (RN-ENV-031).
import { eventually, generateCpf, seededRandom, type KycScenarioDigit } from '@broker/testing';
import { createHmac } from 'node:crypto';
import { expectStatus, http, urls, WebSession, type HttpResponse } from './edge.js';

export interface CustomerProfile {
  email: string;
  password: string;
  fullName: string;
  phone: string;
  taxId: string;
  /** Pontos do suitability (v1: 0 a 50). */
  suitabilityPoints?: number;
}

/** Cliente de teste com CPF do cenário de KYC escolhido; `seed` fixo dá sempre o mesmo CPF. */
export function customerProfile(
  name: string,
  kycDigit: KycScenarioDigit,
  seed: number,
  email = `${name}@exemplo.com`,
): CustomerProfile {
  const random = seededRandom(seed);
  return {
    email,
    password: 'Broker#Local2026',
    fullName: 'Cliente Teste Silva',
    phone: `+55119${String(random.int(10_000_000, 99_999_999))}`,
    taxId: generateCpf({ penultimateDigit: kycDigit, random }),
  };
}

// ------------------------------------------------------------------ códigos enviados

/** Último código de 6 dígitos enviado por e-mail depois de `since` (caixa de captura do Mailpit). */
export function emailCode(to: string, since: number): Promise<string> {
  return eventually(
    async () => {
      const list = await http<{ messages: { ID: string; Created: string; Subject: string }[] }>(
        `${urls.mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${to}" subject:"Código de verificação"`)}`,
      );
      const recent = list.body.messages.find((m) => Date.parse(m.Created) >= since - 1000);
      if (!recent) throw new Error(`sem e-mail de código para ${to}`);
      const msg = await http<{ Text: string }>(`${urls.mailpit}/api/v1/message/${recent.ID}`);
      const code = /(\d{6})/.exec(msg.body.Text)?.[1];
      if (!code) throw new Error('e-mail sem código');
      return code;
    },
    { timeoutMs: 20_000, intervalMs: 300 },
  );
}

/** Último código de 6 dígitos enviado por SMS depois de `since` (message-sink). */
export function smsCode(to: string, since: number): Promise<string> {
  return eventually(
    async () => {
      const list = await http<{ messages: { body: string; created_at: string }[] }>(
        `${urls.sms}/v1/messages?channel=SMS&to=${encodeURIComponent(to)}`,
      );
      const recent = list.body.messages
        .filter((m) => Date.parse(m.created_at) >= since - 1000)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
      const code = recent && /(\d{6})/.exec(recent.body)?.[1];
      if (!code) throw new Error(`sem SMS de código para ${to}`);
      return code;
    },
    { timeoutMs: 20_000, intervalMs: 300 },
  );
}

// ------------------------------------------------------------------ segundo fator (TOTP)

/** Código TOTP (RFC 6238: HMAC-SHA1, 6 dígitos, passo de 30 s) do segredo em base32 no instante. */
export function totp(secretBase32: string, atMs: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const offset = h[h.length - 1]! & 0x0f;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Ativa o autenticador (TOTP) da conta e devolve o segredo, para gerar os próximos códigos. */
export async function enrollTotp(web: WebSession, atMs: number): Promise<string> {
  const { secret } = ok(await web.post<{ secret: string }>('/v1/me/mfa/totp'), 201);
  ok(await web.post('/v1/me/mfa/totp/confirm', { code: totp(secret, atMs) }), 200);
  return secret;
}

// ------------------------------------------------------------------ cadastro e onboarding

/** Cadastro (ou o já existente) e login no canal web; com autenticador, `mfaCode` completa o login. */
export async function signIn(c: CustomerProfile, mfaCode?: () => string): Promise<WebSession> {
  const web = new WebSession();
  const reg = await web.post<{ code?: string }>('/v1/auth/register', {
    email: c.email,
    password: c.password,
    fullName: c.fullName,
    taxId: c.taxId,
  });
  if (reg.status !== 201 && !(reg.status === 409 && reg.body.code === 'EMAIL_ALREADY_REGISTERED'))
    expectStatus(reg, 201);
  await web.login(c.email, c.password, mfaCode);
  return web;
}

/** PNG mínimo com as dimensões no cabeçalho IHDR (o que a inspeção de documento lê). */
export function png(width: number, height: number, size = 4096): Buffer {
  const b = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** Respostas do questionário v1 que somam `target` pontos (8 perguntas, pesos 0/2/4/6 e 0..3). */
export function answersFor(target: number): Record<string, string> {
  const ids = [
    'objective',
    'horizon',
    'knowledge',
    'experience',
    'frequency',
    'loss_reaction',
    'share',
  ];
  const answers: Record<string, string> = {};
  let left = target;
  const liq = left % 2 === 1 ? 1 : 0;
  answers['liquidity'] = 'abcd'[liq]!;
  left -= liq;
  for (const id of ids) {
    const w = Math.min(6, left);
    answers[id] = 'abcd'[w / 2]!;
    left -= w;
  }
  if (left !== 0) throw new Error(`não dá para somar ${target}`);
  return answers;
}

export interface OnboardingView {
  applicationId: string;
  status: string;
  nextStep: string | null;
  decisionReason: string | null;
}

const ok = <B>(res: HttpResponse<B>, ...status: number[]) =>
  expectStatus(res, ...(status.length ? status : [200, 201, 204])).body;

/**
 * Preenche as etapas que faltam e submete ao KYC (Onboarding §4–§5). Retomável: começa no
 * `nextStep` da solicitação; já submetida ou decidida, só devolve o estado.
 */
export async function completeOnboarding(
  web: WebSession,
  c: CustomerProfile,
): Promise<OnboardingView> {
  for (;;) {
    const view = ok(await web.get<OnboardingView>('/v1/me/onboarding'), 200);
    switch (view.nextStep) {
      case 'CONTACT_VERIFIED': {
        const since = Date.now();
        ok(await web.put('/v1/me/onboarding/contact', { email: c.email, phone: c.phone }));
        const [emailCodeValue, phoneCode] = await Promise.all([
          emailCode(c.email, since),
          smsCode(c.phone, since),
        ]);
        ok(
          await web.post('/v1/me/onboarding/contact/verify', {
            emailCode: emailCodeValue,
            phoneCode,
          }),
        );
        break;
      }
      case 'PERSONAL_DATA':
        ok(
          await web.put('/v1/me/onboarding/personal-data', {
            fullName: c.fullName,
            taxId: c.taxId,
            birthDate: '1990-05-10',
            nationality: 'BRAZILIAN',
            maritalStatus: 'SINGLE',
            motherName: 'Joana Teste Silva',
            idDocument: {
              type: 'RG',
              number: '123456789',
              issuer: 'SSP',
              issuerState: 'SP',
              issueDate: '2015-01-10',
            },
          }),
        );
        break;
      case 'ADDRESS':
        ok(
          await web.put('/v1/me/onboarding/address', {
            zipCode: '01310100',
            street: 'Avenida Paulista',
            number: '1000',
            district: 'Bela Vista',
            city: 'São Paulo',
            state: 'SP',
          }),
        );
        break;
      case 'FINANCIAL_PROFILE':
        ok(
          await web.put('/v1/me/onboarding/financial-profile', {
            occupation: 'EMPLOYEE',
            monthlyIncome: '8000.00',
            declaredNetWorth: '150000.00',
            pep: false,
            linkedPerson: false,
            fundsOrigin: 'Salário',
            foreignTaxResidency: false,
          }),
        );
        break;
      case 'DOCUMENTS':
        for (const type of ['ID_FRONT', 'SELFIE']) await uploadDocument(web, type, png(1200, 900));
        break;
      case 'SUITABILITY':
        ok(
          await web.post('/v1/me/suitability/assessments', {
            questionnaireVersion: 1,
            answers: answersFor(c.suitabilityPoints ?? 20),
          }),
        );
        break;
      case 'TERMS': {
        const pending = ok(
          await web.get<{
            terms: { termsId: string; version: number; moment: string; mandatory: boolean }[];
          }>('/v1/me/terms/pending'),
          200,
        );
        for (const t of pending.terms.filter((x) => x.mandatory && x.moment === 'ONBOARDING'))
          ok(await web.post(`/v1/me/terms/${t.termsId}/accept`, { version: t.version }));
        break;
      }
      case 'SUBMIT':
        ok(await web.post('/v1/me/onboarding/submit'), 202);
        break;
      default:
        return view;
    }
  }
}

/** URL assinada → PUT direto no MinIO → registro do documento. */
async function uploadDocument(web: WebSession, type: string, body: Buffer): Promise<void> {
  const { documentId, uploadUrl } = ok(
    await web.post<{ documentId: string; uploadUrl: string }>(
      '/v1/me/onboarding/documents/upload-url',
      { type, contentType: 'image/png', sizeBytes: body.length },
    ),
  );
  expectStatus(
    await http(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      raw: body,
    }),
    200,
  );
  ok(await web.post('/v1/me/onboarding/documents', { documentId }));
}

/** Espera a decisão do KYC (webhook do simulador) sair de `UNDER_REVIEW`. */
export function kycDecision(web: WebSession): Promise<OnboardingView> {
  return eventually(
    async () => {
      const view = ok(await web.get<OnboardingView>('/v1/me/onboarding'), 200);
      if (view.status === 'UNDER_REVIEW') throw new Error('KYC ainda em análise');
      return view;
    },
    { timeoutMs: 30_000, intervalMs: 500 },
  );
}

export interface AccountProfile {
  account: { accountId: string; accountNumber: string; status: string };
}

/**
 * Espera a saga de abertura (conta → `account.opened` → conta no ledger) e renova o access token,
 * que passa a levar o `account_id` (as rotas `/v1/me` usam a conta do token, RN-API-043).
 */
export async function activeAccount(web: WebSession): Promise<AccountProfile['account']> {
  const account = await eventually(
    async () => {
      expectStatus(await web.post('/v1/auth/token/refresh'), 200);
      const profile = ok(await web.get<AccountProfile>('/v1/me/profile'), 200);
      if (profile.account?.status !== 'ACTIVE')
        throw new Error(`conta ainda não ativa: ${JSON.stringify(profile.account)}`);
      // O ledger cria a conta ao consumir `account.opened`: o saldo responde quando ela chegou lá.
      const b = await web.get('/v1/me/balances');
      if (b.status !== 200)
        throw new Error(
          `saldo ${b.status} para a conta ${profile.account.accountId}; token: ${JSON.stringify(web.accessClaims())}`,
        );
      return profile.account;
    },
    // O consumidor de um serviço recém-reiniciado só assume o stream quando o broker solta a
    // conexão antiga (consumidor ativo único): folga para isso.
    { timeoutMs: 90_000, intervalMs: 1000 },
  );
  return account;
}

// ------------------------------------------------------------------ dinheiro

export interface BankAccount {
  id: string;
  tipo: string;
  titular: { cpf?: string };
  saldo: string;
}

/** Conta do cliente no Banco Simulado (criada na abertura da conta, RN-ONB-002). */
export function bankAccountOf(taxId: string): Promise<BankAccount> {
  return eventually(
    async () => {
      const res = ok(await http<{ contas: BankAccount[] }>(`${urls.bank}/contas`), 200);
      const conta = res.contas.find((x) => x.tipo === 'CLIENTE' && x.titular.cpf === taxId);
      if (!conta) throw new Error(`sem conta no Banco Simulado para ${taxId}`);
      return conta;
    },
    { timeoutMs: 20_000, intervalMs: 500 },
  );
}

export interface DepositView {
  id: string;
  status: string;
  amount: string;
}

/** Depósito PIX: cobrança → o cliente paga no Banco Simulado → webhook → crédito (RN-DEP-*). */
export async function deposit(
  web: WebSession,
  taxId: string,
  amount: string,
): Promise<DepositView> {
  const created = ok(await web.post<DepositView>('/v1/me/deposits', { amount }), 201);
  const conta = await bankAccountOf(taxId);
  const txid = created.id.replaceAll('-', '');
  expectStatus(
    await http(`${urls.bank}/cob/${txid}/pagar`, {
      method: 'POST',
      body: { contaPagadora: conta.id },
    }),
    201,
  );
  return eventually(
    async () => {
      const d = ok(await web.get<DepositView>(`/v1/me/deposits/${created.id}`), 200);
      if (d.status !== 'CREDITED') throw new Error(`depósito ${d.status}`);
      return d;
    },
    { timeoutMs: 30_000, intervalMs: 500 },
  );
}

export interface Balances {
  settled: string;
  withdrawable: string;
  holds: string;
  asOf: string;
}

export const balances = async (web: WebSession) =>
  ok(await web.get<Balances>('/v1/me/balances'), 200);
