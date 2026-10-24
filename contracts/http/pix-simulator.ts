// API do "Banco Simulado" (Sistemas simulados §2). É documentada como API de TERCEIRO (RN-SIM-001):
// os nomes seguem o estilo da API Pix do Banco Central (`cob`, `txid`, `endToEndId`, `devolucao`) e
// não o modelo do núcleo. O adaptador do núcleo traduz; nenhum desses nomes vaza para o ledger.
import Type from 'typebox';
import { defineHttpContract } from '../src/define.js';

const Amount = Type.String({
  pattern: '^\\d{1,13}\\.\\d{2}$',
  description: 'Valor em reais, ex.: "100.00".',
});
const Cpf = Type.String({ pattern: '^\\d{11}$' });
const Instant = Type.String({ format: 'date-time' });
const EndToEndId = Type.String({
  pattern: '^ESIM\\d{14}[a-z0-9]{14}$',
  description:
    'Identificador fim a fim (32 caracteres), sempre com o prefixo de simulação ESIM (RN-PIXS-001).',
});
const Txid = Type.String({ pattern: '^[a-zA-Z0-9]{26,35}$' });

/** Titular: pessoa física (`cpf`) ou jurídica (`cnpj`, a corretora). */
export const Party = Type.Object({
  cpf: Type.Optional(Cpf),
  cnpj: Type.Optional(Type.String({ pattern: '^\\d{14}$' })),
  nome: Type.String(),
});

export const PixKey = Type.Object({
  chave: Type.String(),
  tipo: Type.Union([Type.Literal('CPF'), Type.Literal('CNPJ'), Type.Literal('EVP')]),
});

export const CreateAccount = Type.Object({
  cpf: Cpf,
  nome: Type.String({ minLength: 1, maxLength: 120 }),
  tipo: Type.Optional(Type.Union([Type.Literal('CLIENTE'), Type.Literal('TERCEIRO')])),
  /** Sem ele: R$ 100.000,00 no sandbox e R$ 10.000,00 nos demais ambientes (§2.1). */
  saldoInicial: Type.Optional(Amount),
});

export const Account = Type.Object({
  id: Type.String({ format: 'uuid' }),
  agencia: Type.String(),
  numero: Type.String(),
  tipo: Type.Union([Type.Literal('CLIENTE'), Type.Literal('TERCEIRO'), Type.Literal('CORRETORA')]),
  titular: Party,
  saldo: Amount,
  chaves: Type.Array(PixKey),
  criadaEm: Instant,
});

export const CreateCharge = Type.Object({
  calendario: Type.Object({
    expiracao: Type.Integer({ minimum: 60, maximum: 604_800, description: 'Segundos.' }),
  }),
  valor: Type.Object({ original: Amount }),
  devedor: Type.Optional(Type.Object({ cpf: Cpf, nome: Type.String() })),
  solicitacaoPagador: Type.Optional(Type.String({ maxLength: 140 })),
});

export const Charge = Type.Object({
  txid: Txid,
  status: Type.Union([
    Type.Literal('ATIVA'),
    Type.Literal('CONCLUIDA'),
    Type.Literal('REMOVIDA_POR_EXPIRACAO'),
  ]),
  calendario: Type.Object({ criacao: Instant, expiracao: Type.Integer() }),
  valor: Type.Object({ original: Amount }),
  chave: Type.String(),
  devedor: Type.Optional(Type.Object({ cpf: Cpf, nome: Type.String() })),
  solicitacaoPagador: Type.Optional(Type.String()),
  /** Payload "copia e cola" no formato EMV do BR Code, com GUI de simulação (`br.sim.pix`). */
  pixCopiaECola: Type.String(),
  pix: Type.Array(Type.Object({ endToEndId: EndToEndId, valor: Amount, horario: Instant })),
});

export const PayCharge = Type.Object({ contaPagadora: Type.String({ format: 'uuid' }) });

export const SendPix = Type.Object({
  /** Identificador do envio, único por envio: repetir devolve o mesmo resultado (idempotência). */
  idEnvio: Type.String({ pattern: '^[a-zA-Z0-9]{1,35}$' }),
  valor: Amount,
  chave: Type.String({ minLength: 1, maxLength: 77 }),
  /** Se informado, o envio é recusado quando o titular da chave for outro (titularidade). */
  cpfRecebedor: Type.Optional(Cpf),
  descricao: Type.Optional(Type.String({ maxLength: 140 })),
});

export const Refund = Type.Object({
  id: Type.String(),
  rtrId: EndToEndId,
  valor: Amount,
  horario: Instant,
  status: Type.Literal('DEVOLVIDO'),
});

export const Pix = Type.Object({
  endToEndId: EndToEndId,
  tipo: Type.Union([Type.Literal('COBRANCA'), Type.Literal('ENVIO'), Type.Literal('DEVOLUCAO')]),
  status: Type.Union([Type.Literal('CONCLUIDO'), Type.Literal('NAO_REALIZADO')]),
  /** Código da recusa quando `NAO_REALIZADO` (ex.: `CHAVE_INEXISTENTE`). */
  motivo: Type.Optional(Type.String()),
  txid: Type.Optional(Txid),
  idEnvio: Type.Optional(Type.String()),
  valor: Amount,
  horario: Instant,
  pagador: Party,
  recebedor: Party,
  descricao: Type.Optional(Type.String()),
  devolucoes: Type.Array(Refund),
});

export const KeyLookup = Type.Object({
  chave: Type.String(),
  tipo: PixKey.properties.tipo,
  titular: Type.Object({
    cpf: Type.Optional(Cpf),
    cnpj: Type.Optional(Type.String()),
    /** Nome mascarado: "Maria S*** S***". */
    nomeMascarado: Type.String(),
  }),
});

/**
 * Corpo do webhook de PIX recebido (`X-Webhook-Event: pix.recebido`), assinado com HMAC-SHA256
 * sobre `timestamp.corpo` (RN-SIM-003). Traz o pagador REAL, que pode não ser o devedor da cobrança.
 */
export const PixReceivedWebhook = Type.Object({
  pix: Type.Array(
    Type.Object({
      endToEndId: EndToEndId,
      txid: Txid,
      valor: Amount,
      horario: Instant,
      pagador: Party,
    }),
  ),
});

export const pixSimulatorHttp = defineHttpContract({
  service: 'pix-simulator',
  title: 'Banco Simulado (PIX)',
  version: '1.0.0',
  routes: {
    createAccount: {
      method: 'post',
      path: '/contas',
      summary: 'Abre uma conta (cliente aprovado ou terceiro de teste) com chaves CPF e aleatória.',
      auth: 'public',
      body: CreateAccount,
      responses: {
        201: { description: 'Conta aberta.', body: Account },
        200: {
          description: 'Já existia conta deste tipo para o CPF: devolve a mesma.',
          body: Account,
        },
      },
    },
    listAccounts: {
      method: 'get',
      path: '/contas',
      summary: 'Lista as contas.',
      auth: 'public',
      responses: {
        200: { description: 'Contas.', body: Type.Object({ contas: Type.Array(Account) }) },
      },
    },
    getAccount: {
      method: 'get',
      path: '/contas/:id',
      summary: 'Consulta uma conta.',
      auth: 'public',
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      responses: {
        200: { description: 'A conta.', body: Account },
        404: { description: 'Conta inexistente.' },
      },
    },
    createCharge: {
      method: 'put',
      path: '/cob/:txid',
      summary: 'Cria uma cobrança imediata para a conta da corretora.',
      auth: 'public',
      params: Type.Object({ txid: Txid }),
      body: CreateCharge,
      responses: {
        201: { description: 'Cobrança criada.', body: Charge },
        200: { description: 'Repetição com o mesmo corpo: a mesma cobrança.', body: Charge },
        409: { description: 'TXID_EM_USO: o txid já existe com outro conteúdo.' },
      },
    },
    getCharge: {
      method: 'get',
      path: '/cob/:txid',
      summary: 'Consulta uma cobrança e os PIX que a pagaram.',
      auth: 'public',
      params: Type.Object({ txid: Txid }),
      responses: {
        200: { description: 'A cobrança.', body: Charge },
        404: { description: 'Cobrança inexistente.' },
      },
    },
    payCharge: {
      method: 'post',
      path: '/cob/:txid/pagar',
      summary:
        'Paga a cobrança com a conta escolhida (é o que o cliente faz na UI; exposto para testes).',
      auth: 'public',
      params: Type.Object({ txid: Txid }),
      body: PayCharge,
      responses: {
        201: { description: 'Pago; o webhook `pix.recebido` é enviado à corretora.', body: Pix },
        422: { description: 'COBRANCA_EXPIRADA, COBRANCA_JA_PAGA ou SALDO_INSUFICIENTE.' },
      },
    },
    sendPix: {
      method: 'post',
      path: '/pix',
      summary: 'Envia um PIX da conta da corretora para uma chave (saque).',
      auth: 'public',
      body: SendPix,
      responses: {
        201: { description: 'PIX concluído.', body: Pix },
        200: { description: 'Repetição do mesmo idEnvio: o mesmo resultado.', body: Pix },
        422: {
          description:
            'CHAVE_INEXISTENTE, TITULARIDADE_DIVERGENTE, SALDO_INSUFICIENTE ou PIX_REJEITADO.',
        },
      },
    },
    listPix: {
      method: 'get',
      path: '/pix',
      summary: 'Lista PIX por txid ou por período (reconciliação, RN-PIXS-002).',
      auth: 'public',
      query: Type.Object({
        txid: Type.Optional(Txid),
        inicio: Type.Optional(Instant),
        fim: Type.Optional(Instant),
      }),
      responses: {
        200: { description: 'PIX encontrados.', body: Type.Object({ pix: Type.Array(Pix) }) },
      },
    },
    getPix: {
      method: 'get',
      path: '/pix/:e2eid',
      summary: 'Consulta um PIX pelo endToEndId.',
      auth: 'public',
      params: Type.Object({ e2eid: EndToEndId }),
      responses: {
        200: { description: 'O PIX.', body: Pix },
        404: { description: 'PIX inexistente.' },
      },
    },
    refundPix: {
      method: 'put',
      path: '/pix/:e2eid/devolucao/:id',
      summary: 'Devolve integralmente um PIX recebido pela corretora.',
      auth: 'public',
      params: Type.Object({
        e2eid: EndToEndId,
        id: Type.String({ pattern: '^[a-zA-Z0-9]{1,35}$' }),
      }),
      body: Type.Object({ valor: Amount }),
      responses: {
        201: { description: 'Devolvido.', body: Refund },
        200: { description: 'Repetição do mesmo id: a mesma devolução.', body: Refund },
        422: { description: 'VALOR_DEVOLUCAO_INVALIDO, PIX_NAO_DEVOLVIVEL ou SALDO_INSUFICIENTE.' },
        409: { description: 'PIX_JA_DEVOLVIDO com outro id.' },
      },
    },
    lookupKey: {
      method: 'get',
      path: '/chaves/:chave',
      summary: 'Consulta o titular de uma chave (CPF e nome mascarado).',
      auth: 'public',
      params: Type.Object({ chave: Type.String({ minLength: 1, maxLength: 77 }) }),
      responses: {
        200: { description: 'Titular.', body: KeyLookup },
        404: { description: 'CHAVE_INEXISTENTE.' },
      },
    },
  },
});

export default pixSimulatorHttp;
