import { pixSimulatorHttp } from '@broker/contracts/http/pix-simulator';
import type { Service } from '@broker/service-kit';
import type { PixBank } from './bank.js';

const r = pixSimulatorHttp.routes;

/**
 * API do Banco Simulado, com os esquemas do contrato (`contracts/http/pix-simulator.ts`). As
 * operações têm idempotência natural (txid, idEnvio, id da devolução, CPF da conta), então não
 * exigem `Idempotency-Key`.
 */
export function registerApi(service: Service, bank: PixBank): void {
  service.route({
    method: 'post',
    path: '/contas',
    auth: 'public',
    idempotent: false,
    validate: { body: r.createAccount.body },
    handler: async (req) => {
      const { created, account } = await bank.openAccount(req.body);
      return { status: created ? 201 : 200, body: account };
    },
  });
  service.route({
    method: 'get',
    path: '/contas',
    auth: 'public',
    handler: async () => ({ body: { contas: await bank.listAccounts() } }),
  });
  service.route({
    method: 'get',
    path: '/contas/:id',
    auth: 'public',
    validate: { params: r.getAccount.params },
    handler: async (req) => ({ body: await bank.getAccount(req.params.id) }),
  });

  service.route({
    method: 'put',
    path: '/cob/:txid',
    auth: 'public',
    validate: { params: r.createCharge.params, body: r.createCharge.body },
    handler: async (req) => {
      const { created, charge } = await bank.createCharge(req.params.txid, req.body);
      return { status: created ? 201 : 200, body: charge };
    },
  });
  service.route({
    method: 'get',
    path: '/cob/:txid',
    auth: 'public',
    validate: { params: r.getCharge.params },
    handler: async (req) => ({ body: await bank.getCharge(req.params.txid) }),
  });
  service.route({
    method: 'post',
    path: '/cob/:txid/pagar',
    auth: 'public',
    idempotent: false,
    validate: { params: r.payCharge.params, body: r.payCharge.body },
    handler: async (req) => ({
      status: 201,
      body: await bank.payCharge(req.params.txid, req.body.contaPagadora),
    }),
  });

  service.route({
    method: 'post',
    path: '/pix',
    auth: 'public',
    idempotent: false,
    validate: { body: r.sendPix.body },
    handler: async (req) => {
      const { created, pix } = await bank.sendPix(req.body);
      return { status: created ? 201 : 200, body: pix };
    },
  });
  service.route({
    method: 'get',
    path: '/pix',
    auth: 'public',
    validate: { query: r.listPix.query },
    handler: async (req) => ({ body: { pix: await bank.listPix(req.query) } }),
  });
  service.route({
    method: 'get',
    path: '/pix/:e2eid',
    auth: 'public',
    validate: { params: r.getPix.params },
    handler: async (req) => ({ body: await bank.getPix(req.params.e2eid) }),
  });
  service.route({
    method: 'put',
    path: '/pix/:e2eid/devolucao/:id',
    auth: 'public',
    validate: { params: r.refundPix.params, body: r.refundPix.body },
    handler: async (req) => {
      const { created, refund } = await bank.refund(
        req.params.e2eid,
        req.params.id,
        req.body.valor,
      );
      return { status: created ? 201 : 200, body: refund };
    },
  });

  service.route({
    method: 'get',
    path: '/chaves/:chave',
    auth: 'public',
    validate: { params: r.lookupKey.params },
    handler: async (req) => ({ body: await bank.lookupKey(req.params.chave) }),
  });
}
