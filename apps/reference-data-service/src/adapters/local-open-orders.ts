import type { OpenOrdersPort } from '../application/ports.js';

/**
 * Adaptador provisório da Fase 1: ainda não há OMS, então nenhum instrumento tem ordens abertas.
 * Na Fase 2 vira a consulta ao oms-service (ou a projeção local de `order.*`).
 */
export class NoOpenOrdersYet implements OpenOrdersPort {
  async openOrdersCount(): Promise<number> {
    return 0;
  }
}
