import type { Instant } from '@broker/domain-kernel';
import type { RequestKind } from '../domain/budget.js';
import { raiseAlert, type MarketDataDeps } from './context.js';
import { ProviderError } from './provider.js';

const DAY = 86_400_000;

/** Capacidade por tipo de requisição (o `403` desliga a capacidade por 24 h, Brapi §10). */
const CAPABILITY: Partial<Record<RequestKind, string>> = {
  HISTORY: 'history',
  CATALOG: 'catalog',
  RESOLVE: 'resolve',
  USAGE: 'usage',
};

/**
 * Tratamento das falhas do provedor que não são do disjuntor nem do orçamento (Brapi §10):
 * - `400`: não repetir, registrar e alertar (parâmetro ou limite do plano na configuração);
 * - `403`: capacidade indisponível por 24 h (fallback manual);
 * - corpo inválido: não repetir na hora, guardar o corpo bruto e alertar.
 * `401` e `429` por cota ficam no controlador de orçamento; `5xx`/timeout, na fila.
 */
export class ProviderHealth {
  private readonly unavailable = new Map<string, Instant>();

  constructor(private readonly d: MarketDataDeps) {}

  async load(): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      for (const c of new Set(Object.values(CAPABILITY))) {
        const until = await tx.capabilityUnavailableUntil(c);
        if (until) this.unavailable.set(c, until);
      }
    });
  }

  gate(kind: RequestKind): string | null {
    const cap = CAPABILITY[kind];
    const until = cap ? this.unavailable.get(cap) : undefined;
    if (!until || !this.d.clock.now().isBefore(until)) return null;
    return `capacidade ${cap} indisponível no plano até ${until.toString()}`;
  }

  async report(
    kind: RequestKind,
    err: unknown,
    context: Record<string, unknown> = {},
  ): Promise<void> {
    if (!(err instanceof ProviderError)) return;
    if (err.kind === 'FORBIDDEN') {
      const cap = CAPABILITY[kind] ?? kind.toLowerCase();
      const until = this.d.clock.now().plusMillis(DAY);
      this.unavailable.set(cap, until);
      await this.d.store.transaction(async (tx) => {
        await tx.markCapabilityUnavailable(cap, until, err.message);
        await raiseAlert(
          this.d,
          tx,
          'CAPABILITY_UNAVAILABLE',
          'WARNING',
          `brapi negou ${cap} (403): indisponível por 24 h, usar o cadastro manual`,
          { ...context, capability: cap },
        );
      });
    } else if (err.kind === 'BAD_REQUEST') {
      await this.d.store.transaction((tx) =>
        raiseAlert(
          this.d,
          tx,
          'BAD_REQUEST',
          'WARNING',
          `brapi recusou o pedido (400): confira os limites do plano na configuração`,
          {
            ...context,
            message: err.message,
          },
        ),
      );
    } else if (err.kind === 'INVALID_BODY') {
      const raw = err.details.raw;
      if (raw) {
        await this.d.raw
          .put(`invalid/${raw.receivedAt.businessDate().toString()}/${raw.sha256}.txt`, raw.body)
          .catch(() => undefined);
      }
      await this.d.store.transaction((tx) =>
        raiseAlert(this.d, tx, 'INVALID_BODY', 'WARNING', err.message, {
          ...context,
          rawSha256: raw?.sha256 ?? null,
        }),
      );
    }
  }
}
