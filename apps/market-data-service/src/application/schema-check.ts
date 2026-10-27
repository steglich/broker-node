import type { Instant } from '@broker/domain-kernel';
import { raiseAlert, type MarketDataDeps } from './context.js';
import type { ProviderQueue } from './queue.js';

/** Uma sonda da verificação: a chamada real e o corpo gravado com que ela é comparada. */
export interface SchemaProbe {
  name: string;
  /** Faz 1 requisição e devolve o corpo bruto (JSON em texto). */
  fetch: () => Promise<string>;
  /** Corpo da fixture gravada (RN-BRP-100). */
  expected: unknown;
}

export interface SchemaCheckSettings {
  /** Desligado por padrão no ambiente local (RN-BRP-095): não gasta cota em desenvolvimento. */
  enabled: boolean;
  /** Dia da semana ISO (1 = segunda) e horário de São Paulo, fora do pregão. Padrão: segunda 07:00. */
  weekday: number;
  at: string;
}

export interface SchemaDrift {
  probe: string;
  /** Caminho → tipo esperado / encontrado (`missing` quando sumiu). */
  changed: { path: string; expected: string; actual: string }[];
  /** Campos novos: só informação, o leitor tolerante ignora. */
  added: string[];
}

/** Caminhos e tipos JSON de um corpo; itens de lista viram `[]`. */
export function shapeOf(
  value: unknown,
  path = '',
  out = new Map<string, string>(),
): Map<string, string> {
  if (Array.isArray(value)) {
    out.set(path || '/', 'array');
    for (const item of value) shapeOf(item, `${path}[]`, out);
  } else if (value !== null && typeof value === 'object') {
    out.set(path || '/', 'object');
    for (const [k, v] of Object.entries(value)) shapeOf(v, `${path}/${k}`, out);
  } else if (value !== null) {
    out.set(path, typeof value);
  } else if (!out.has(path)) {
    out.set(path, 'null');
  }
  return out;
}

/**
 * Compara o formato real com o gravado. Campo que sumiu ou mudou de tipo é deriva; `null` de um lado
 * e valor do outro não é (campos opcionais vêm nulos).
 */
export function compareShapes(name: string, expected: unknown, actual: unknown): SchemaDrift {
  const e = shapeOf(expected);
  const a = shapeOf(actual);
  const changed: SchemaDrift['changed'] = [];
  for (const [path, type] of e) {
    const got = a.get(path);
    if (got === undefined) {
      // Lista vazia na resposta real: os caminhos dos itens não aparecem, sem ser deriva.
      const parentArray = [...a.entries()].some(
        ([p, t]) => t === 'array' && path.startsWith(`${p}[]`) && !a.has(`${p}[]`),
      );
      if (!parentArray) changed.push({ path, expected: type, actual: 'missing' });
    } else if (got !== type && got !== 'null' && type !== 'null') {
      changed.push({ path, expected: type, actual: got });
    }
  }
  const added = [...a.keys()].filter((p) => !e.has(p));
  return { probe: name, changed, added };
}

/**
 * Verificação semanal do esquema (RN-BRP-100): fora do pregão, 1–2 requisições reais conferem se o
 * formato da brapi ainda bate com as fixtures dos testes de contrato. Deriva vira alerta de
 * manutenção. Uma execução por semana ISO (`provider_job_run`), mesmo com várias instâncias.
 */
export class SchemaCheck {
  constructor(
    private readonly d: MarketDataDeps,
    private readonly queue: ProviderQueue,
    private readonly settings: SchemaCheckSettings,
    private readonly probes: readonly SchemaProbe[],
  ) {}

  /** Chamado pelo laço do líder; só roda no dia e depois do horário, uma vez por semana. */
  async runIfDue(): Promise<SchemaDrift[] | null> {
    if (!this.settings.enabled) return null;
    const now = this.d.clock.now();
    const date = now.businessDate();
    if (date.isoWeekday() !== this.settings.weekday) return null;
    if (now.isBefore(date.atLocalTime(this.settings.at))) return null;
    const claimed = await this.d.store.transaction((tx) =>
      tx.claimPeriodicRun('brapi_schema_check', isoWeek(now), now),
    );
    if (!claimed) return null;
    return this.run();
  }

  async run(): Promise<SchemaDrift[]> {
    const drifts: SchemaDrift[] = [];
    for (const p of this.probes) {
      let body: unknown;
      try {
        const text = await this.queue.enqueue({
          key: `schema:${p.name}`,
          kind: 'SCHEMA_CHECK',
          priority: 5,
          run: p.fetch,
        });
        body = JSON.parse(text);
      } catch (err) {
        drifts.push({
          probe: p.name,
          changed: [
            { path: '/', expected: 'json', actual: err instanceof Error ? err.message : 'erro' },
          ],
          added: [],
        });
        continue;
      }
      const drift = compareShapes(p.name, p.expected, body);
      if (drift.changed.length || drift.added.length) drifts.push(drift);
    }
    const broken = drifts.filter((x) => x.changed.length > 0);
    await this.d.store.transaction(async (tx) => {
      if (broken.length)
        await raiseAlert(
          this.d,
          tx,
          'SCHEMA_DRIFT',
          'WARNING',
          'o formato da brapi mudou em relação às fixtures: revise o adaptador',
          { drifts: broken },
        );
      else
        this.d.logger.info(
          { event: 'market_data.schema_check', probes: this.probes.length, added: drifts.length },
          'esquema da brapi confere com as fixtures',
        );
    });
    return drifts;
  }
}

/** `2026-W44` (semana ISO do instante em São Paulo). */
export function isoWeek(at: Instant): string {
  const d = at.businessDate();
  const weekday = d.isoWeekday();
  const thursday = d.plusDays(4 - weekday);
  const year = thursday.year();
  const jan1 = Date.UTC(year, 0, 1) / 86_400_000;
  const week = Math.floor((thursday.epochDay - jan1) / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}
