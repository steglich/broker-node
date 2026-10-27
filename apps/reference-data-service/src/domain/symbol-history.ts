import type { BusinessDate, Instant } from '@broker/domain-kernel';
import { ReferenceRuleError } from './errors.js';
import { assertSymbol, type Instrument } from './instrument.js';

/** Ticker antigo com vigência (`instrument_symbol_history`, RN-INS-030); datas inclusivas. */
export interface SymbolHistoryEntry {
  instrumentId: string;
  symbol: string;
  validFrom: BusinessDate;
  validTo: BusinessDate;
  conversionRatio: string | null;
}

/**
 * Renomeação (RN-INS-030): o `instrument_id` fica, o ticker antigo vai para o histórico valendo
 * de `currentSince` até a véspera de `effectiveDate`. Razão de conversão ≠ 1 não é renomeação, é
 * evento corporativo entre instrumentos (RN-INS-031).
 */
export function rename(
  i: Instrument,
  input: {
    newSymbol: string;
    effectiveDate: BusinessDate;
    /** Desde quando o ticker atual vale: a renomeação anterior ou a data do cadastro. */
    currentSince: BusinessDate;
    conversionRatio?: string | null;
  },
  now: Instant,
): { instrument: Instrument; history: SymbolHistoryEntry } {
  assertSymbol(input.newSymbol);
  if (input.newSymbol === i.symbol)
    throw new ReferenceRuleError('SAME_SYMBOL', `O ticker já é ${i.symbol}.`);
  if (i.status === 'DELISTED')
    throw new ReferenceRuleError('INSTRUMENT_DELISTED', `${i.symbol} está deslistado.`);
  if (input.conversionRatio != null && !isOne(input.conversionRatio))
    throw new ReferenceRuleError(
      'CONVERSION_IS_CORPORATE_ACTION',
      `Conversão ${i.symbol} → ${input.newSymbol} com razão ${input.conversionRatio}: trate como evento corporativo.`,
    );
  if (!input.effectiveDate.isAfter(input.currentSince))
    throw new ReferenceRuleError(
      'INVALID_EFFECTIVE_DATE',
      `A renomeação precisa valer depois de ${input.currentSince.toString()}.`,
    );
  return {
    instrument: { ...i, symbol: input.newSymbol, updatedAt: now },
    history: {
      instrumentId: i.id,
      symbol: i.symbol,
      validFrom: input.currentSince,
      validTo: input.effectiveDate.plusDays(-1),
      conversionRatio: input.conversionRatio ?? null,
    },
  };
}

/** RN-INS-032: "Ticker alterado de X para Y em dd/mm/aaaa" (data em que Y passou a valer). */
export function renameNotice(oldSymbol: string, newSymbol: string, since: BusinessDate): string {
  const [y, m, d] = since.toString().split('-');
  return `Ticker alterado de ${oldSymbol} para ${newSymbol} em ${d}/${m}/${y}`;
}

const isOne = (ratio: string) => Number(ratio) === 1;
