import type { CorporateActionsPort, ExposurePort } from '../application/ports.js';

/** Fase 1: sem OMS nem custódia, ninguém tem posição ou ordem aberta (todo o universo em P1). */
export class NoExposureYet implements ExposurePort {
  async exposedInstruments(): Promise<ReadonlySet<string>> {
    return new Set();
  }
}

/** Fase 1: o corporate-actions-service chega na Fase 4; nenhum evento conhecido. */
export class NoCorporateActionsYet implements CorporateActionsPort {
  async knownActionOn(): Promise<boolean> {
    return false;
  }
}
