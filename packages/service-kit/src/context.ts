import { AsyncLocalStorage } from 'node:async_hooks';
import type { Instant } from '@broker/domain-kernel';
import type { Actor } from '@broker/messaging';

export type Channel = 'WEB' | 'MOBILE' | 'DESKTOP' | 'BACKOFFICE' | 'SERVICE' | 'SYSTEM';

/**
 * Contexto de execução de todo comando (RN-BE-011). Criado pelo middleware HTTP (ou pelo
 * consumidor de eventos) e disponível em qualquer ponto da chamada via `currentContext()`.
 */
export interface ExecutionContext {
  actor: Actor;
  accountId?: string;
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
  channel: Channel;
  ip?: string;
  userAgent?: string;
  /** Instante da requisição no relógio do ambiente. */
  requestedAt: Instant;
  /** Escopos e papéis do token, para a autorização no caso de uso (RN-BE-012). */
  scopes: ReadonlySet<string>;
  roles: ReadonlySet<string>;
}

const storage = new AsyncLocalStorage<ExecutionContext>();

export const runWithContext = <T>(ctx: ExecutionContext, fn: () => T): T => storage.run(ctx, fn);
export const currentContext = (): ExecutionContext | undefined => storage.getStore();

export function requireContext(): ExecutionContext {
  const ctx = storage.getStore();
  if (!ctx) throw new Error('chamada fora de um contexto de execução');
  return ctx;
}

export const ANONYMOUS: Actor = { type: 'USER', id: 'anonymous' };
