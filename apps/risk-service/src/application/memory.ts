import { Decimal } from '@broker/domain-kernel';
import { emptyProjection, type AccountProjection } from '../domain/projection.js';

/**
 * A projeção em memória (D13) e a fila por conta (RN-RSK-001): quem decide ou aplica um evento de uma
 * conta espera os anteriores dela. A fila some quando esvazia: o número de contas não pesa aqui.
 */
export class RiskMemory {
  private readonly accounts = new Map<string, AccountProjection>();
  private readonly tails = new Map<string, Promise<unknown>>();
  readonly prices = new Map<string, { price: Decimal; seq: number }>();
  /** Contas com poder de compra possivelmente mudado, à espera do próximo aviso (throttle). */
  readonly dirty = new Set<string>();
  readonly lastPublished = new Map<string, string>();

  account(id: string): AccountProjection {
    return this.accounts.get(id) ?? emptyProjection(id);
  }

  put(p: AccountProjection): void {
    this.accounts.set(p.accountId, p);
    this.dirty.add(p.accountId);
  }

  /** Troca tudo pelo que está no banco (ao assumir a liderança). */
  reset(
    accounts: readonly AccountProjection[],
    prices: readonly { instrumentId: string; price: Decimal; seq: number }[],
  ): void {
    this.accounts.clear();
    this.dirty.clear();
    this.lastPublished.clear();
    this.prices.clear();
    for (const p of accounts) this.accounts.set(p.accountId, p);
    for (const p of prices) this.prices.set(p.instrumentId, { price: p.price, seq: p.seq });
  }

  size(): number {
    return this.accounts.size;
  }

  /** Executa em série com tudo o que já foi pedido para a conta. */
  async inTurn<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(accountId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.catch(() => undefined);
    this.tails.set(accountId, tail);
    try {
      return await run;
    } finally {
      if (this.tails.get(accountId) === tail) this.tails.delete(accountId);
    }
  }
}
