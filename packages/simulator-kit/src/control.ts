import { businessRule, type Service } from '@broker/service-kit';
import type { DeliveryRow } from '@broker/webhooks';
import express from 'express';
import Type from 'typebox';
import { formatLatency, parseLatency, type SimulatorControl } from './behavior.js';
import { html, type SafeHtml, table } from './html.js';

/** Cenário forçável, com o rótulo que aparece na UI. */
export interface ScenarioOption<S extends string> {
  id: S;
  label: string;
}

const BehaviorPatch = Type.Object({
  latencyMs: Type.Optional(Type.String({ pattern: '^\\d+(-\\d+)?$' })),
  transientErrorRate: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  transientMode: Type.Optional(
    Type.Union([Type.Literal('status'), Type.Literal('timeout'), Type.Literal('mixed')]),
  ),
  definitiveErrorRate: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

const behaviorView = (control: SimulatorControl) => ({
  latencyMs: formatLatency(control.behavior.latency),
  transientErrorRate: control.behavior.transientErrorRate,
  transientMode: control.behavior.transientMode,
  definitiveErrorRate: control.behavior.definitiveErrorRate,
  unavailability: control.behavior.unavailability.map((w) => ({
    from: w.from.toString(),
    to: w.to.toString(),
  })),
  unavailableUntil: control.unavailableUntil()?.toString() ?? null,
  scenarios: control.armedScenarios(),
});

/**
 * Rotas de controle comuns aos simuladores (RN-SIM-002/005): `/admin/*` em JSON, para testes
 * automatizados, e `/ui/control/*` com formulários, para a UI de inspeção. Registre ANTES do
 * `control.middleware()`: o controle nunca sofre a falha simulada.
 */
export function registerControlRoutes<S extends string>(
  service: Service,
  control: SimulatorControl<S>,
  scenarios: readonly ScenarioOption<S>[],
): void {
  service.use(express.urlencoded({ extended: false, limit: '16kb' }));
  const known = new Set<string>(scenarios.map((s) => s.id));
  const checkScenario = (id: string): S => {
    if (!known.has(id)) throw businessRule('UNKNOWN_SCENARIO', `Cenário desconhecido: ${id}.`);
    return id as S;
  };
  const patch = (body: Record<string, unknown>) => {
    const b = body as {
      latencyMs?: string;
      transientErrorRate?: number;
      transientMode?: 'status';
      definitiveErrorRate?: number;
    };
    control.behavior = {
      ...control.behavior,
      ...(b.latencyMs !== undefined ? { latency: parseLatency(b.latencyMs) } : {}),
      ...(b.transientErrorRate !== undefined ? { transientErrorRate: b.transientErrorRate } : {}),
      ...(b.transientMode !== undefined ? { transientMode: b.transientMode } : {}),
      ...(b.definitiveErrorRate !== undefined
        ? { definitiveErrorRate: b.definitiveErrorRate }
        : {}),
    };
  };
  const back = { status: 303, headers: { Location: '/ui' } };

  service.route({
    method: 'get',
    path: '/admin/behavior',
    auth: 'public',
    handler: async () => ({ body: behaviorView(control) }),
  });
  service.route({
    method: 'put',
    path: '/admin/behavior',
    auth: 'public',
    validate: { body: BehaviorPatch },
    handler: async (req) => {
      patch(req.body);
      return { body: behaviorView(control) };
    },
  });
  service.route({
    method: 'post',
    path: '/admin/unavailability',
    auth: 'public',
    idempotent: false,
    validate: { body: Type.Object({ minutes: Type.Integer({ minimum: 1, maximum: 1440 }) }) },
    handler: async (req) => {
      const w = control.makeUnavailable(req.body.minutes);
      return { status: 201, body: { from: w.from.toString(), to: w.to.toString() } };
    },
  });
  service.route({
    method: 'delete',
    path: '/admin/unavailability',
    auth: 'public',
    handler: async () => {
      control.clearUnavailability();
      return { status: 204 };
    },
  });
  service.route({
    method: 'post',
    path: '/admin/scenarios',
    auth: 'public',
    idempotent: false,
    validate: {
      body: Type.Object({
        scenario: Type.String(),
        times: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
    },
    handler: async (req) => {
      control.arm(checkScenario(req.body.scenario), req.body.times ?? 1);
      return { status: 201, body: { scenarios: control.armedScenarios() } };
    },
  });
  service.route({
    method: 'delete',
    path: '/admin/scenarios/:scenario',
    auth: 'public',
    handler: async (req) => {
      control.disarm(checkScenario((req.params as { scenario: string }).scenario));
      return { status: 204 };
    },
  });

  // Formulários da UI (application/x-www-form-urlencoded): respondem 303 de volta para /ui.
  service.route({
    method: 'post',
    path: '/ui/control/behavior',
    auth: 'public',
    idempotent: false,
    handler: async (req) => {
      const f = req.body as Record<string, string>;
      patch({
        latencyMs: f['latencyMs'] || '0',
        transientErrorRate: Number(f['transientErrorRate'] || 0),
        transientMode: f['transientMode'] || 'status',
        definitiveErrorRate: Number(f['definitiveErrorRate'] || 0),
      });
      return back;
    },
  });
  service.route({
    method: 'post',
    path: '/ui/control/unavailability',
    auth: 'public',
    idempotent: false,
    handler: async (req) => {
      const minutes = Number((req.body as Record<string, string>)['minutes'] || 0);
      if (minutes > 0) control.makeUnavailable(minutes);
      else control.clearUnavailability();
      return back;
    },
  });
  service.route({
    method: 'post',
    path: '/ui/control/scenarios',
    auth: 'public',
    idempotent: false,
    handler: async (req) => {
      const f = req.body as Record<string, string>;
      const scenario = checkScenario(f['scenario'] ?? '');
      if (f['action'] === 'disarm') control.disarm(scenario);
      else control.arm(scenario);
      return back;
    },
  });
}

/** Seção da UI com o comportamento e os cenários forçáveis. */
export function controlSection<S extends string>(
  control: SimulatorControl<S>,
  scenarios: readonly ScenarioOption<S>[],
): SafeHtml {
  const b = control.behavior;
  const armed = new Map(control.armedScenarios().map((a) => [a.scenario, a.remaining]));
  const until = control.unavailableUntil();
  return html`<section>
    <h2>Comportamento (RN-SIM-002)</h2>
    <form class="inline" method="post" action="/ui/control/behavior">
      <label
        >Latência (ms ou mín-máx)
        <input name="latencyMs" value="${formatLatency(b.latency)}" size="8"
      /></label>
      <label
        >Erro transitório <input name="transientErrorRate" value="${b.transientErrorRate}" size="4"
      /></label>
      <label
        >Modo
        <select name="transientMode">
          ${(['status', 'timeout', 'mixed'] as const).map(
            (m) =>
              html`<option value="${m}" ${m === b.transientMode ? html`selected` : ''}>
                ${m}
              </option>`,
          )}
        </select></label
      >
      <label
        >Erro definitivo
        <input name="definitiveErrorRate" value="${b.definitiveErrorRate}" size="4"
      /></label>
      <button>Salvar</button>
    </form>
    <form class="inline" method="post" action="/ui/control/unavailability">
      <span
        >${until ? html`<strong>Fora do ar até ${until.toString()}</strong>` : 'Disponível.'}</span
      >
      <input name="minutes" value="10" size="3" /> min <button>Derrubar</button>
    </form>
    <form class="inline" method="post" action="/ui/control/unavailability">
      <input type="hidden" name="minutes" value="0" /><button>Religar</button>
    </form>
    <h2 style="margin-top:12px">Cenários forçáveis</h2>
    ${table(
      ['Cenário', 'Armado', ''],
      scenarios.map((s) => [
        s.label,
        armed.get(s.id) ?? 0,
        html`<form class="inline" method="post" action="/ui/control/scenarios">
          <input type="hidden" name="scenario" value="${s.id}" />
          <button name="action" value="arm">Armar próximo</button>
          ${armed.has(s.id) ? html`<button name="action" value="disarm">Desarmar</button>` : ''}
        </form>`,
      ]),
    )}
  </section>`;
}

/** Seção da UI com as últimas entregas de webhook (RN-SIM-004). */
export function deliveriesSection(rows: readonly DeliveryRow[]): SafeHtml {
  return html`<section>
    <h2>Webhooks enviados</h2>
    ${table(
      [
        'Criado',
        'Evento',
        'ID',
        'Status',
        'Tentativas',
        'Último HTTP',
        'Próxima tentativa',
        'Erro',
      ],
      rows.map((r) => [
        r.created_at,
        r.event_type,
        html`<code>${r.event_id}</code>`,
        r.status,
        r.attempts,
        r.last_status ?? '—',
        r.status === 'PENDING' ? r.next_attempt_at : '—',
        r.last_error ?? '',
      ]),
    )}
  </section>`;
}
