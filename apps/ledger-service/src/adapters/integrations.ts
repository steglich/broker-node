import { Instant, Money } from '@broker/domain-kernel';
import type { ServiceTokenProvider } from '@broker/service-kit';
import {
  IntegrationError,
  type BankTransaction,
  type CustomerDirectory,
  type PixGateway,
  type WithdrawalDestination,
} from '../application/ports.js';

const TIMEOUT_MS = 10_000;

/** Rede, timeout e `5xx` são transitórios; `4xx` é definitivo, com o código do terceiro. */
async function call(what: string, url: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new IntegrationError('TRANSIENT', 'UNAVAILABLE', `${what}: ${(err as Error).message}`);
  }
  if (res.status >= 500 || res.status === 429) {
    await res.body?.cancel();
    throw new IntegrationError(
      'TRANSIENT',
      `HTTP_${res.status}`,
      `${what} respondeu ${res.status}`,
    );
  }
  return res;
}

async function problemCode(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { code?: string };
  return body.code ?? `HTTP_${res.status}`;
}

const brl = (v: string) => Money.of(v, 'BRL');

interface PixView {
  endToEndId: string;
  tipo: 'COBRANCA' | 'ENVIO' | 'DEVOLUCAO';
  status: 'CONCLUIDO' | 'NAO_REALIZADO';
  valor: string;
  horario: string;
  devolucoes: { rtrId: string }[];
}

const KIND = { COBRANCA: 'CHARGE_PAYMENT', ENVIO: 'TRANSFER', DEVOLUCAO: 'REFUND' } as const;

const toTransaction = (p: PixView): BankTransaction => ({
  endToEndId: p.endToEndId,
  kind: KIND[p.tipo],
  completed: p.status === 'CONCLUIDO',
  amount: brl(p.valor),
  at: Instant.ofEpochMillis(Date.parse(p.horario)),
  refunds: p.devolucoes.map((d) => d.rtrId),
});

/**
 * ACL do Banco Simulado (Sistemas simulados §2): `cob`, `pix`, `devolucao` e os nomes em português
 * ficam aqui; o núcleo fala de cobrança, envio e devolução.
 */
export class HttpPixGateway implements PixGateway {
  constructor(private readonly baseUrl: string) {}

  async createCharge(input: { txid: string; amount: Money; expiresInSeconds: number }) {
    const res = await call('Banco Simulado', `${this.baseUrl}/cob/${input.txid}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendario: { expiracao: input.expiresInSeconds },
        valor: { original: input.amount.round('HALF_UP').amount.toFixed(2) },
      }),
    });
    if (!res.ok)
      throw new IntegrationError('DEFINITIVE', await problemCode(res), 'cobrança recusada');
    const body = (await res.json()) as { pixCopiaECola: string };
    return { copyPaste: body.pixCopiaECola };
  }

  async refund(input: { endToEndId: string; refundId: string; amount: Money }) {
    const res = await call(
      'Banco Simulado',
      `${this.baseUrl}/pix/${input.endToEndId}/devolucao/${input.refundId}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ valor: input.amount.amount.toFixed(2) }),
      },
    );
    if (!res.ok)
      throw new IntegrationError('DEFINITIVE', await problemCode(res), 'devolução recusada');
    const body = (await res.json()) as { rtrId: string };
    return { returnId: body.rtrId };
  }

  async send(input: { sendId: string; amount: Money; pixKey: string; holderTaxId: string | null }) {
    const res = await call('Banco Simulado', `${this.baseUrl}/pix`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idEnvio: input.sendId,
        valor: input.amount.amount.toFixed(2),
        chave: input.pixKey,
        ...(input.holderTaxId ? { cpfRecebedor: input.holderTaxId } : {}),
        descricao: 'Saque Corretora Estudo',
      }),
    });
    if (!res.ok) throw new IntegrationError('DEFINITIVE', await problemCode(res), 'PIX recusado');
    const body = (await res.json()) as { endToEndId: string };
    return { endToEndId: body.endToEndId };
  }

  async transactions(from: Instant, to: Instant) {
    const q = new URLSearchParams({ inicio: from.toString(), fim: to.toString() });
    const res = await call('Banco Simulado', `${this.baseUrl}/pix?${q}`);
    if (!res.ok)
      throw new IntegrationError('DEFINITIVE', await problemCode(res), 'consulta recusada');
    return ((await res.json()) as { pix: PixView[] }).pix.map(toTransaction);
  }

  async transaction(endToEndId: string) {
    const res = await call('Banco Simulado', `${this.baseUrl}/pix/${endToEndId}`);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok)
      throw new IntegrationError('DEFINITIVE', await problemCode(res), 'consulta recusada');
    return toTransaction((await res.json()) as PixView);
  }
}

/**
 * Rotas internas do customer-service, com token de serviço (client credentials): titularidade,
 * elegibilidade e destino do saque. Fora do ar → `IntegrationError` TRANSIENT.
 */
export class HttpCustomerDirectory implements CustomerDirectory {
  constructor(
    private readonly baseUrl: string,
    private readonly tokens: Pick<ServiceTokenProvider, 'token'>,
  ) {}

  private async get(path: string, init: RequestInit = {}) {
    const res = await call('customer-service', `${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${await this.tokens.token()}`,
      },
    });
    return res;
  }

  async holderMatches(accountId: string, taxId: string) {
    const res = await this.get(`/v1/internal/accounts/${accountId}/holder-match`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taxId }),
    });
    if (res.status === 404) return false;
    if (!res.ok) throw new IntegrationError('DEFINITIVE', await problemCode(res), 'titularidade');
    return ((await res.json()) as { matches: boolean }).matches;
  }

  async eligibility(accountId: string, operation: 'DEPOSIT' | 'WITHDRAW') {
    const res = await this.get(
      `/v1/internal/accounts/${accountId}/eligibility?operation=${operation}`,
    );
    if (res.status === 404) return { allowed: false, code: 'ACCOUNT_NOT_ACTIVE' };
    if (!res.ok) throw new IntegrationError('DEFINITIVE', await problemCode(res), 'elegibilidade');
    const body = (await res.json()) as { allowed: boolean; code?: string };
    return { allowed: body.allowed, ...(body.code ? { code: body.code } : {}) };
  }

  async withdrawalDestination(
    accountId: string,
    bankAccountId: string,
  ): Promise<WithdrawalDestination | null> {
    const res = await this.get(
      `/v1/internal/accounts/${accountId}/withdrawal-accounts/${bankAccountId}`,
    );
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw new IntegrationError('DEFINITIVE', await problemCode(res), 'destino');
    const body = (await res.json()) as {
      id: string;
      status: 'ACTIVE' | 'REMOVED';
      pixKey: string;
      availableFrom: string;
      holderTaxId?: string;
    };
    return {
      id: body.id,
      status: body.status,
      pixKey: body.pixKey,
      availableFrom: Instant.parse(body.availableFrom),
      holderTaxId: body.holderTaxId ?? null,
    };
  }
}
