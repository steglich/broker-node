import type { Service } from '@broker/service-kit';
import {
  controlSection,
  deliveriesSection,
  html,
  page,
  table,
  type SimulatorControl,
} from '@broker/simulator-kit';
import type { WebhookDispatcher } from '@broker/webhooks';
import type { KycProvider } from './provider.js';
import { KYC_SCENARIOS, type KycScenario } from './rules.js';

/** UI de inspeção do provedor de KYC (RN-SIM-005): verificações, resultados e controles. */
export function registerUi(
  service: Service,
  provider: KycProvider,
  control: SimulatorControl<KycScenario>,
  dispatcher: WebhookDispatcher,
): void {
  service.route({
    method: 'get',
    path: '/ui',
    auth: 'public',
    handler: async () => {
      const [checks, deliveries] = await Promise.all([provider.list(), dispatcher.list(50)]);
      const body = html` ${controlSection(control, KYC_SCENARIOS)}
        <section>
          <h2>Verificações</h2>
          <p class="muted">
            Regra pelo penúltimo dígito do CPF: 0–6 aprova; 7 FACE_MATCH 50–79; 8 WATCHLIST; 9 CPF
            irregular.
          </p>
          ${table(
            ['Criada', 'check_id', 'reference_id', 'Status', 'Resultados', 'Concluída'],
            checks.map((c) => [
              c.created_at,
              html`<code>${c.check_id}</code>`,
              c.reference_id,
              c.status,
              html`${c.verifications.map(
                (v) =>
                  html`<div>
                    ${v.type}:
                    <strong>${v.status}</strong>${v.score !== undefined ? ` (${v.score})` : ''}
                  </div>`,
              )}`,
              c.completed_at ?? '—',
            ]),
          )}
        </section>
        ${deliveriesSection(deliveries)}`;
      return { type: 'text/html', body: page('Provedor de KYC simulado', body) };
    },
  });
}
