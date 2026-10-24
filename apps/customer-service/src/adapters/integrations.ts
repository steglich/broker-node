import type { ServiceTokenProvider } from '@broker/service-kit';
import { randomUUID } from 'node:crypto';
import type { BankPort, ClosureCheck, ClosurePendency, KycProvider } from '../application/ports.js';

async function json(res: Response, what: string): Promise<unknown> {
  if (!res.ok) throw new Error(`${what} respondeu HTTP ${res.status}`);
  return res.json();
}

/**
 * ACL do KYC simulado (RN-ONB-021): traduz para a API do provedor (snake_case, inglês). O resultado
 * chega depois por webhook assinado.
 */
export class HttpKycProvider implements KycProvider {
  constructor(private readonly baseUrl: string) {}

  async submit(input: Parameters<KycProvider['submit']>[0]) {
    const res = await fetch(`${this.baseUrl}/v1/checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        reference_id: input.referenceId,
        tax_id: input.taxId,
        full_name: input.fullName,
        birth_date: input.birthDate,
        documents: input.documents,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await json(res, 'KYC simulado')) as { check_id: string };
    return { checkId: body.check_id };
  }
}

/** ACL do Banco Simulado (Sistemas simulados §2): nomes da API Pix não vazam para o núcleo. */
export class HttpBank implements BankPort {
  constructor(private readonly baseUrl: string) {}

  async openAccount(taxId: string, name: string) {
    const res = await fetch(`${this.baseUrl}/contas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cpf: taxId, nome: name, tipo: 'CLIENTE' }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await json(res, 'Banco Simulado')) as { id: string };
    return { id: body.id };
  }

  async lookupKey(key: string) {
    const res = await fetch(`${this.baseUrl}/chaves/${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    const body = (await json(res, 'Banco Simulado')) as {
      tipo: string;
      titular: { cpf?: string; nomeMascarado: string };
    };
    return {
      type: body.tipo,
      holderTaxId: body.titular.cpf ?? null,
      holderNameMasked: body.titular.nomeMascarado,
    };
  }
}

/**
 * Pendências de encerramento num serviço dono (RN-ACC-012): `GET /v1/internal/accounts/{id}/
 * closure-pendencies` com token de serviço. Cada dono implementa a rota no seu grupo.
 */
export class HttpClosureCheck implements ClosureCheck {
  constructor(
    readonly source: ClosurePendency['source'],
    private readonly baseUrl: string,
    private readonly tokens: Pick<ServiceTokenProvider, 'token'>,
  ) {}

  async pendencies(accountId: string): Promise<ClosurePendency[]> {
    const res = await fetch(
      `${this.baseUrl}/v1/internal/accounts/${accountId}/closure-pendencies`,
      {
        headers: { authorization: `Bearer ${await this.tokens.token()}` },
        signal: AbortSignal.timeout(2000),
      },
    );
    const body = (await json(res, this.source)) as {
      pendencies: { code: string; message: string }[];
    };
    return body.pendencies.map((p) => ({ source: this.source, code: p.code, message: p.message }));
  }
}
