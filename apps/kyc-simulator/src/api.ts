import { kycSimulatorHttp } from '@broker/contracts/http/kyc-simulator';
import type { Service } from '@broker/service-kit';
import type { KycProvider } from './provider.js';

const r = kycSimulatorHttp.routes;

export function registerApi(service: Service, provider: KycProvider): void {
  service.route({
    method: 'post',
    path: '/v1/checks',
    auth: 'public',
    // Cada submissão é uma verificação nova; o núcleo controla a repetição pelo reference_id.
    idempotent: false,
    validate: { body: r.submitCheck.body },
    handler: async (req) => ({ status: 202, body: await provider.submit(req.body) }),
  });
  service.route({
    method: 'get',
    path: '/v1/checks/:check_id',
    auth: 'public',
    validate: { params: r.getCheck.params },
    handler: async (req) => ({ body: await provider.get(req.params.check_id) }),
  });
}
