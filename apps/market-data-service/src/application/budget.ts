import type { Instant } from '@broker/domain-kernel';
import {
  assessBudget,
  assumedWindow,
  levelAllows,
  type BudgetAssessment,
  type BudgetLevel,
  type Priority,
  type ProviderUsage,
  type RequestKind,
} from '../domain/budget.js';
import { raiseAlert, type MarketDataDeps } from './context.js';
import type { MarketDataTx, UsageRow } from './ports.js';
import type { ProviderError } from './provider.js';

const HOUR = 3_600_000;
/** Requisições que exigem token (a trava do `401` as bloqueia). */
const AUTHENTICATED: ReadonlySet<RequestKind> = new Set([
  'QUOTE',
  'INDEX_QUOTE',
  'ON_DEMAND_QUOTE',
  'HISTORY',
  'USAGE',
]);

/**
 * Controlador de orçamento (RN-BRP-030..035, Brapi §5): contador local por janela, corrigido pelo
 * endpoint de uso (E9), reserva de segurança e níveis `NORMAL`/`SAVING`/`CRITICAL`/`EXHAUSTED`.
 * Cada mudança de nível publica `market_data.provider_budget_level_changed`; `EXHAUSTED` também
 * vira alerta crítico. Provedores sem cota (fixtures, replay) ficam sempre em `NORMAL`.
 */
export class BudgetController {
  private row: UsageRow | undefined;
  private current: BudgetAssessment | undefined;
  /** Impressão digital do token atual (a trava do `401` vale até ele mudar). */
  private token: string | null = null;

  constructor(private readonly d: MarketDataDeps) {}

  get metered(): boolean {
    return this.d.provider.capabilities().metered;
  }

  async load(): Promise<void> {
    this.row = await this.d.store.transaction((tx) => tx.usage());
    this.current = this.assess(this.row);
    if (this.metered && !this.row.usage) {
      // RN-BRP-030: sem leitura do E9, 30 dias móveis a partir de agora, com o limite configurado.
      const now = this.d.clock.now();
      await this.update(async (_tx, row) => ({
        ...row,
        usage: row.usage ?? {
          planName: null,
          planLimit: this.d.budgetPolicy.monthlyRequests,
          currentUsage: 0,
          remaining: this.d.budgetPolicy.monthlyRequests,
          window: assumedWindow(now),
        },
      }));
    }
  }

  setTokenFingerprint(fp: string | null): void {
    this.token = fp;
  }

  level(): BudgetLevel {
    return this.metered ? (this.current?.level ?? 'NORMAL') : 'NORMAL';
  }

  assessment():
    (BudgetAssessment & { usage: ProviderUsage | null; usageReadAt: Instant | null }) | null {
    if (!this.row || !this.current) return null;
    return { ...this.current, usage: this.row.usage, usageReadAt: this.row.usageReadAt };
  }

  /** Motivo da recusa (ou `null`): nível do orçamento e trava do `401`. */
  gate(kind: RequestKind, priority: Priority, symbol?: string): string | null {
    const tokenless =
      symbol !== undefined && this.d.provider.capabilities().tokenlessSymbols.includes(symbol);
    if (
      this.row?.authBlockedToken &&
      this.row.authBlockedToken === this.token &&
      AUTHENTICATED.has(kind) &&
      !tokenless
    )
      return 'token recusado (401): requisições autenticadas paradas até a troca do token';
    if (!this.metered) return null;
    const level = this.level();
    if (kind === 'USAGE' && level === 'EXHAUSTED' && !this.usageDue())
      return 'EXHAUSTED: E9 só a cada 6 h';
    return levelAllows(level, kind, priority) ? null : `orçamento ${level}`;
  }

  /** E9 vencido? 1×/hora no pregão, 1×/6 h fora dele e em `EXHAUSTED` (Brapi §4). */
  usageDue(inSession = false): boolean {
    if (!this.metered) return false;
    const last = this.row?.usageReadAt;
    if (!last) return true;
    const every = inSession && this.level() !== 'EXHAUSTED' ? HOUR : 6 * HOUR;
    return this.d.clock.now().epochMillis - last.epochMillis >= every;
  }

  /** Cada envio que chegou à fonte conta (RN-BRP-032). */
  async onSent(kind: RequestKind, outcome: { ok: boolean; error?: ProviderError }): Promise<void> {
    const reached = outcome.ok || outcome.error?.reachedProvider === true;
    const unauthorized = outcome.error?.kind === 'UNAUTHORIZED';
    const quota = outcome.error?.kind === 'RATE_LIMITED' && outcome.error.details.quota === true;
    if (!this.metered && !unauthorized) return;
    if (!reached && !unauthorized) return;
    await this.update(async (tx, row) => {
      const next: UsageRow = {
        ...row,
        sentSinceUsage:
          this.metered && reached && kind !== 'USAGE' ? row.sentSinceUsage + 1 : row.sentSinceUsage,
        quotaExhausted: row.quotaExhausted || quota,
      };
      if (unauthorized && row.authBlockedToken !== this.token) {
        next.authBlockedToken = this.token;
        await raiseAlert(
          this.d,
          tx,
          'UNAUTHORIZED',
          'CRITICAL',
          'brapi recusou o token (401): requisições autenticadas paradas até a troca do segredo',
          {
            endpointKind: kind,
          },
        );
      }
      return next;
    });
  }

  /** Leitura do E9: corrige o contador local e o nível (RN-BRP-030/032). */
  async applyUsage(usage: ProviderUsage): Promise<void> {
    await this.update(async (_tx, row) => ({
      ...row,
      usage,
      usageReadAt: this.d.clock.now(),
      sentSinceUsage: 0,
      quotaExhausted: row.quotaExhausted && usage.remaining <= 0,
      authBlockedToken: null,
    }));
  }

  /** Libera a trava do `401` manualmente (backoffice, depois de trocar o token). */
  async clearAuthBlock(): Promise<void> {
    await this.update(async (_tx, row) => ({ ...row, authBlockedToken: null }));
  }

  /** Reavalia o nível (ex.: virou o dia) e publica se mudou. */
  async refresh(): Promise<void> {
    await this.update(async (_tx, row) => row);
  }

  private async update(change: (tx: MarketDataTx, row: UsageRow) => Promise<UsageRow>) {
    await this.d.store.transaction(async (tx) => {
      const row = await tx.usage({ forUpdate: true });
      const next = await change(tx, row);
      const assessment = this.assess(next);
      const level = this.metered ? assessment.level : 'NORMAL';
      if (level !== row.level) {
        await tx.publish(
          {
            type: 'market_data.provider_budget_level_changed',
            payload: {
              from: row.level,
              to: level,
              remaining: assessment.remaining,
              projectedExhaustion: assessment.projectedExhaustion?.toString() ?? null,
            },
          },
          'brapi',
        );
        if (level === 'EXHAUSTED')
          await raiseAlert(
            this.d,
            tx,
            'QUOTA_EXHAUSTED',
            'CRITICAL',
            'cota da brapi esgotada: nenhuma cotação até renovar o ciclo; preços marcados como defasados',
            {
              remaining: assessment.remaining,
              windowEnd: next.usage?.window.end.toString() ?? null,
            },
          );
        else
          await raiseAlert(
            this.d,
            tx,
            'BUDGET_LEVEL',
            level === 'NORMAL' ? 'INFO' : 'WARNING',
            `orçamento da brapi: ${row.level} → ${level}`,
            { remaining: assessment.remaining },
          );
      }
      const saved = { ...next, level };
      await tx.saveUsage(saved);
      this.row = saved;
      this.current = assessment;
    });
  }

  private assess(row: UsageRow): BudgetAssessment {
    const now = this.d.clock.now();
    const usage: ProviderUsage = row.usage ?? {
      planName: null,
      planLimit: this.d.budgetPolicy.monthlyRequests,
      currentUsage: 0,
      remaining: this.d.budgetPolicy.monthlyRequests,
      window: assumedWindow(now),
    };
    return assessBudget({
      now,
      policy: this.d.budgetPolicy,
      usage,
      sentSinceUsage: row.sentSinceUsage,
      quotaExhausted: row.quotaExhausted,
      businessDaysBetween: (a, b) => {
        try {
          return this.d.calendar.businessDaysBetween(a, b);
        } catch {
          // Fora do calendário carregado: estimativa por dias da semana.
          let n = 0;
          for (let x = a.plusDays(1); !x.isAfter(b); x = x.plusDays(1)) if (!x.isWeekend()) n++;
          return n;
        }
      },
    });
  }
}
