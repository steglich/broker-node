import { Decimal, type Instant } from '@broker/domain-kernel';
import { relativeChange } from './quote.js';

/** O que fazer com uma leitura bem-sucedida (Brapi §9.3). */
export type Disposition =
  /** RN-BRP-072: `quote_time` anterior à última aceita. Descartada, sem evento. */
  | 'DISCARDED_OUT_OF_ORDER'
  /** Mesmo `quote_time` da última aceita: nada mudou na fonte (conta para o agendamento). */
  | 'UNCHANGED'
  /** RN-BRP-071: salto acima de `jump_alert_pct` sem evento corporativo. Não é publicada. */
  | 'QUARANTINED'
  /** Aceita; com `releasedFromQuarantine`, confirmou um salto que estava em quarentena. */
  | 'ACCEPTED';

export interface AcceptedState {
  /** Último preço aceito (a âncora do preço de referência). */
  price: string;
  quoteTime: Instant;
}

export interface QuarantinedReading {
  price: string;
  quoteTime: Instant;
}

export interface AcceptanceInput {
  last: AcceptedState | null;
  quarantined: QuarantinedReading | null;
  reading: { price: string; quoteTime: Instant };
  /** Fração; padrão 0,05 (5%). */
  jumpAlertPct: string;
  /** Há evento corporativo conhecido para o instrumento (o salto é esperado). */
  corporateActionKnown: boolean;
}

export interface AcceptanceDecision {
  disposition: Disposition;
  releasedFromQuarantine: boolean;
  /** A quarentena pendente some (liberada, substituída por leitura normal ou descartada). */
  clearQuarantine: boolean;
  jumpPct: string | null;
}

/**
 * Decide o destino da leitura. Regras:
 * - fora de ordem (RN-BRP-072) → descarte; igual à última → `UNCHANGED`;
 * - salto > `jumpAlertPct` da âncora sem evento corporativo (RN-BRP-071) → quarentena;
 * - com leitura em quarentena, a seguinte confirma o salto quando também foge da âncora e fica a
 *   menos de `jumpAlertPct` da que está em quarentena: duas leituras consecutivas consistentes
 *   liberam o novo preço (que entra com glide). Se a seguinte voltou para perto da âncora, a
 *   quarentena cai e a leitura é aceita normalmente; se saltou de novo para outro lado, ela
 *   substitui a anterior na quarentena.
 */
export function decide(input: AcceptanceInput): AcceptanceDecision {
  const { last, quarantined, reading } = input;
  const limit = new Decimal(input.jumpAlertPct);
  const base = { releasedFromQuarantine: false, clearQuarantine: false, jumpPct: null };
  if (last && reading.quoteTime.isBefore(last.quoteTime))
    return { ...base, disposition: 'DISCARDED_OUT_OF_ORDER' };
  if (last && reading.quoteTime.equals(last.quoteTime))
    return { ...base, disposition: 'UNCHANGED' };
  if (quarantined && !reading.quoteTime.isAfter(quarantined.quoteTime))
    return { ...base, disposition: 'DISCARDED_OUT_OF_ORDER' };
  if (!last || input.corporateActionKnown)
    return { ...base, disposition: 'ACCEPTED', clearQuarantine: quarantined !== null };

  const jump = relativeChange(reading.price, last.price);
  const jumpPct = jump.toFixed(6);
  if (jump.lte(limit))
    return { ...base, disposition: 'ACCEPTED', clearQuarantine: quarantined !== null, jumpPct };
  if (quarantined && relativeChange(reading.price, quarantined.price).lte(limit))
    return {
      disposition: 'ACCEPTED',
      releasedFromQuarantine: true,
      clearQuarantine: true,
      jumpPct,
    };
  return { ...base, disposition: 'QUARANTINED', jumpPct };
}
