// 19.3 testes de contrato: o BFF expõe exatamente o que o contrato dele diz, e cada repasse chega
// a uma rota que existe no contrato do dono, com o mesmo método e a mesma política de acesso.
import { bffWebHttp } from '@broker/contracts/http/bff-web';
import type { HttpContract } from '@broker/contracts';
import { describe, expect, it } from 'vitest';
import { OWN_ROUTES, ROUTES, UPSTREAM_CONTRACTS, type Upstream } from '../src/routes.js';

const key = (m: string, p: string) => `${m.toUpperCase()} ${p}`;

async function upstreamContract(service: Upstream): Promise<HttpContract> {
  const mod = (await import(`@broker/contracts/http/${UPSTREAM_CONTRACTS[service]}`)) as {
    default: HttpContract;
  };
  return mod.default;
}

describe('19.3 contrato do bff-web', () => {
  it('as rotas registradas são as do contrato, nem mais nem menos', () => {
    const contract = Object.values(bffWebHttp.routes)
      .map((r) => key(r.method, r.path))
      .sort();
    const registered = [...ROUTES, ...OWN_ROUTES].map((r) => key(r.method, r.path)).sort();
    expect(registered).toEqual(contract);
    expect(new Set(registered).size).toBe(registered.length);
    // A política de acesso também bate.
    for (const r of [...ROUTES, ...OWN_ROUTES]) {
      const c = Object.values(bffWebHttp.routes).find(
        (x) => key(x.method, x.path) === key(r.method, r.path),
      )!;
      expect(c.auth, key(r.method, r.path)).toBe(r.auth);
    }
  });

  it('cada repasse existe no contrato do dono, com o mesmo método e a mesma autenticação', async () => {
    for (const r of ROUTES) {
      const contract = await upstreamContract(r.service);
      const targets = [r.upstream ?? r.path];
      // Rotas com tradução de consulta também podem ir para outro caminho do dono.
      if (r.mapQuery) {
        const alt = r.mapQuery({ search: 'x' }).upstream;
        if (alt) targets.push(alt);
      }
      for (const target of targets) {
        const route = Object.values(contract.routes).find(
          (x) => key(x.method, x.path) === key(r.method, target),
        );
        expect(route, `${key(r.method, r.path)} → ${contract.service} ${target}`).toBeDefined();
        expect(route!.auth, `${key(r.method, r.path)} → ${target}`).toBe(r.auth);
      }
    }
  });

  it('comandos com assinatura no dono são os marcados para anexar o token do cookie', () => {
    const marked = ROUTES.filter((r) => r.signature)
      .map((r) => key(r.method, r.path))
      .sort();
    expect(marked).toEqual([
      'DELETE /v1/me/withdrawal-accounts/:id',
      'POST /v1/me/profile/contact-changes',
      'POST /v1/me/withdrawal-accounts',
      'POST /v1/me/withdrawals',
    ]);
  });
});
