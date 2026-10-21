import type { TSchema, Static } from 'typebox';

/**
 * Definição de um tipo de evento: nome, versão e esquema do payload (RN-MSG-B-020). É a peça que
 * vai para o registro de esquemas em `contracts/` (grupo 7).
 */
export interface EventDefinition<S extends TSchema = TSchema> {
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: S;
  /** Eventos auditáveis vão para a trilha de auditoria (`auditable` do envelope). */
  readonly auditable: boolean;
}

export type PayloadOf<D extends EventDefinition> = Static<D['payload']>;

export function defineEvent<S extends TSchema>(definition: {
  eventType: string;
  eventVersion: number;
  payload: S;
  auditable?: boolean;
}): EventDefinition<S> {
  return { auditable: false, ...definition };
}
