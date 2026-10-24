import type { EventDefinition } from '@broker/messaging';
import type { TSchema } from 'typebox';

/**
 * Contrato de um evento: a definição usada pelo produtor e pelo consumidor (`defineEvent`) mais os
 * metadados do registro. Um arquivo por versão: `contracts/events/<eventType>/v<N>.ts` (D8).
 */
export interface EventContract<S extends TSchema = TSchema> {
  readonly definition: EventDefinition<S>;
  /** Serviço dono do evento: o único que publica (RN-MSG-B §2). */
  readonly producer: string;
  readonly summary: string;
  /** Consumidores declarados (RN-MSG-B-023); servem de documentação no AsyncAPI. */
  readonly consumers?: readonly string[];
  /**
   * Contexto do tópico `<ambiente>.<contexto>.events`, quando não é o primeiro segmento do
   * `eventType` (ex.: `routine.triggered` sai em `scheduler.events`). `'*'`: cada produtor publica
   * no próprio tópico (ex.: `routine.completed`, publicado pelo serviço dono da rotina).
   */
  readonly context?: string;
}

export function defineEventContract<S extends TSchema>(
  contract: EventContract<S>,
): EventContract<S> {
  return contract;
}

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface HttpResponseContract {
  readonly description: string;
  /** Sem corpo quando ausente. Respostas ≥ 400 usam Problem Details (RN-BE-030). */
  readonly body?: TSchema;
}

export interface HttpRouteContract {
  readonly method: HttpMethod;
  /** No formato do Express (`/v1/pings/:id`); vira `/v1/pings/{id}` no OpenAPI. */
  readonly path: string;
  readonly summary: string;
  /** `public`, `user` (JWT) ou `service` (client credentials), como no `service.route`. */
  readonly auth: 'public' | 'user' | 'service';
  /** Exige `Idempotency-Key` (RN-API-010). */
  readonly idempotent?: boolean;
  readonly params?: TSchema;
  readonly query?: TSchema;
  readonly body?: TSchema;
  readonly responses: Readonly<Record<number, HttpResponseContract>>;
}

/** Contrato HTTP de um serviço: `contracts/http/<serviço>.ts` gera `openapi/<serviço>.json` (D8). */
export interface HttpContract<
  R extends Record<string, HttpRouteContract> = Record<string, HttpRouteContract>,
> {
  readonly service: string;
  readonly title: string;
  readonly version: string;
  readonly routes: R;
}

export function defineHttpContract<R extends Record<string, HttpRouteContract>>(
  contract: HttpContract<R>,
): HttpContract<R> {
  return contract;
}
