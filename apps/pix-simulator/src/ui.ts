import { HttpError, type Service } from '@broker/service-kit';
import {
  controlSection,
  deliveriesSection,
  html,
  page,
  table,
  type SimulatorControl,
} from '@broker/simulator-kit';
import type { WebhookDispatcher } from '@broker/webhooks';
import { PIX_SCENARIOS, type PixBank, type PixScenario } from './bank.js';

/**
 * UI de inspeção do Banco Simulado (RN-SIM-005), servida pelo próprio simulador: contas, cobranças
 * (com o formulário de pagamento que o cliente usaria), PIX, webhooks e os controles de falha.
 */
export function registerUi(
  service: Service,
  bank: PixBank,
  control: SimulatorControl<PixScenario>,
  dispatcher: WebhookDispatcher,
): void {
  service.route({
    method: 'get',
    path: '/ui',
    auth: 'public',
    handler: async (req) => {
      const [accounts, charges, pix, deliveries] = await Promise.all([
        bank.listAccounts(),
        bank.listCharges(),
        bank.listPix({ limit: 100 }),
        dispatcher.list(50),
      ]);
      const flash = (req.query as { erro?: string }).erro;
      const payable = accounts.filter((a) => a.tipo !== 'CORRETORA');
      const body = html` ${flash ? html`<section><strong>Erro:</strong> ${flash}</section>` : ''}
        ${controlSection(control, PIX_SCENARIOS)}
        <section>
          <h2>Contas</h2>
          ${table(
            ['Tipo', 'Agência/conta', 'Titular', 'Documento', 'Saldo', 'Chaves'],
            accounts.map((a) => [
              a.tipo,
              `${a.agencia} / ${a.numero}`,
              a.titular.nome,
              a.titular.cpf ?? a.titular.cnpj,
              a.saldo,
              html`${a.chaves.map((k) => html`<div><code>${k.chave}</code> <span class="muted">${k.tipo}</span></div>`)}`,
            ]),
          )}
        </section>
        <section>
          <h2>Cobranças</h2>
          ${table(
            ['txid', 'Valor', 'Status', 'Criada', 'Expira (s)', 'Pagar com'],
            charges.map((c) => [
              html`<code>${c.txid}</code>`,
              c.valor.original,
              c.status,
              c.calendario.criacao,
              c.calendario.expiracao,
              c.status === 'ATIVA'
                ? html`<form class="inline" method="post" action="/ui/cob/${c.txid}/pagar">
                    <select name="contaPagadora">
                      ${payable.map((a) => html`<option value="${a.id}">${a.titular.nome} (${a.saldo})</option>`)}
                    </select>
                    <button>Pagar</button>
                  </form>`
                : '—',
            ]),
          )}
        </section>
        <section>
          <h2>PIX</h2>
          ${table(
            [
              'Horário',
              'endToEndId',
              'Tipo',
              'Status',
              'Valor',
              'Pagador',
              'Recebedor',
              'Devolvido',
            ],
            pix.map((p) => [
              p.horario,
              html`<code>${p.endToEndId}</code>`,
              p.tipo,
              p.motivo ? `${p.status} (${p.motivo})` : p.status,
              p.valor,
              p.pagador.nome,
              p.recebedor.nome,
              p.devolucoes.length > 0 ? 'sim' : '',
            ]),
          )}
        </section>
        ${deliveriesSection(deliveries)}`;
      return { type: 'text/html', body: page('Banco Simulado (PIX)', body) };
    },
  });

  // Pagamento pela UI: é o cliente pagando a cobrança no "app do banco". Não sofre as falhas simuladas.
  service.route({
    method: 'post',
    path: '/ui/cob/:txid/pagar',
    auth: 'public',
    idempotent: false,
    handler: async (req) => {
      const { txid } = req.params as { txid: string };
      try {
        await bank.payCharge(txid, (req.body as { contaPagadora?: string }).contaPagadora ?? '');
        return { status: 303, headers: { Location: '/ui' } };
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        return { status: 303, headers: { Location: `/ui?erro=${encodeURIComponent(err.code)}` } };
      }
    },
  });
}
