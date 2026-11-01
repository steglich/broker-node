import { Decimal } from '@broker/domain-kernel';
import { describe, expect, it } from 'vitest';
import { decideAuctionEnd, outsideStaticBand, staticBandLimits } from '../src/domain/auction.js';
import {
  evaluateCircuitBreaker,
  indexChange,
  nextCircuitBreakerLevel,
} from '../src/domain/circuit-breaker.js';
import { closeDiverges, closingPrice } from '../src/domain/closing.js';
import { haltReasonOfStatus } from '../src/domain/halts.js';
import { effectivePhase, type Phase } from '../src/domain/phases.js';
import { resolveRules } from '../src/domain/trading-rules.js';
import { brt, DAY } from './helpers.js';

const d = (v: string) => new Decimal(v);

describe('RN-SES-001: fase efetiva', () => {
  it('spec "Instrumento em leilão": mercado contínuo e PETR4 em leilão por volatilidade', () => {
    expect(effectivePhase('CONTINUOUS', 'VOLATILITY_AUCTION')).toBe('VOLATILITY_AUCTION');
  });

  it('sem fase própria, segue o mercado', () => {
    expect(effectivePhase('CLOSING_CALL', null)).toBe('CLOSING_CALL');
  });

  it.each<[Phase, Phase, Phase]>([
    ['CONTINUOUS', 'PRE_OPENING', 'PRE_OPENING'],
    ['CLOSING_CALL', 'VOLATILITY_AUCTION', 'CLOSING_CALL'],
    ['POST_CLOSE', 'HALTED', 'HALTED'],
    ['HALTED', 'PRE_OPENING', 'HALTED'],
    ['CLOSING_CALL', 'POST_CLOSE', 'POST_CLOSE'],
    ['CLOSED', 'POST_CLOSE', 'POST_CLOSE'],
    ['PRE_OPENING', 'PRE_TRADING', 'PRE_TRADING'],
  ])('mercado %s e instrumento %s → %s', (market, instrument, expected) => {
    expect(effectivePhase(market, instrument)).toBe(expected);
    expect(effectivePhase(instrument, market)).toBe(expected);
  });
});

describe('RN-AUC-003: decisão no fim previsto', () => {
  const base = {
    bandReferencePrice: d('10'),
    staticBandPct: d('0.08'),
    extensions: 0,
    maxExtensions: 3,
    policy: 'CONCLUDE_AT_BAND' as const,
  };

  it('o limite exato do túnel ainda está dentro dele', () => {
    expect(outsideStaticBand(d('10.80'), d('10'), d('0.08'))).toBe(false);
    expect(outsideStaticBand(d('10.81'), d('10'), d('0.08'))).toBe(true);
    expect(outsideStaticBand(d('9.19'), d('10'), d('0.08'))).toBe(true);
  });

  it('dentro do túnel ou sem teórico, conclui; sem referência, não há o que comparar', () => {
    expect(decideAuctionEnd({ ...base, theoreticalPrice: d('10.5') }).kind).toBe('CONCLUDE');
    expect(decideAuctionEnd({ ...base, theoreticalPrice: null }).kind).toBe('CONCLUDE');
    expect(
      decideAuctionEnd({ ...base, theoreticalPrice: d('50'), bandReferencePrice: null }).kind,
    ).toBe('CONCLUDE');
  });

  it('fora do túnel, prorroga até o máximo; depois segue a política com alerta', () => {
    const outside = { ...base, theoreticalPrice: d('11') };
    expect(decideAuctionEnd({ ...outside, extensions: 2 }).kind).toBe('EXTEND');
    expect(decideAuctionEnd({ ...outside, extensions: 3 })).toEqual({
      kind: 'CONCLUDE',
      alert: true,
      priceLimit: staticBandLimits(d('10'), d('0.08')),
    });
    expect(decideAuctionEnd({ ...outside, extensions: 3, policy: 'KEEP_OPEN' })).toEqual({
      kind: 'HOLD',
      alert: true,
    });
  });

  it('os limites do túnel arredondam para dentro', () => {
    expect(staticBandLimits(d('10.33'), d('0.08'))).toEqual({ min: '9.5036', max: '11.1564' });
    expect(staticBandLimits(d('0.333'), d('0.07'))).toEqual({ min: '0.3097', max: '0.3563' });
  });
});

describe('RN-CB: disparo automático', () => {
  const at = (hhmm: string) => brt(DAY, hhmm);
  const base = {
    triggered: [],
    now: at('13:00'),
    continuousEndsAt: at('16:55'),
    blackoutMinutes: 30,
  };

  it('spec "Nível 1": queda de 10% sobre o fechamento anterior', () => {
    const change = indexChange(d('90000'), d('100000'));
    expect(change.toFixed(2)).toBe('-0.10');
    expect(evaluateCircuitBreaker({ ...base, change })).toBe(1);
    expect(evaluateCircuitBreaker({ ...base, change: d('-0.0999') })).toBeNull();
  });

  it('RN-CB-002 / spec "Última meia hora": 16:40 não dispara; 16:24 ainda dispara', () => {
    const change = d('-0.12');
    expect(evaluateCircuitBreaker({ ...base, change, now: at('16:40') })).toBeNull();
    expect(evaluateCircuitBreaker({ ...base, change, now: at('16:25') })).toBeNull();
    expect(evaluateCircuitBreaker({ ...base, change, now: at('16:24') })).toBe(1);
    expect(evaluateCircuitBreaker({ ...base, change, now: at('16:40'), blackoutMinutes: 0 })).toBe(
      1,
    );
  });

  it('RN-CB-001: níveis em sequência, cada um uma vez', () => {
    expect(nextCircuitBreakerLevel([])).toBe(1);
    expect(nextCircuitBreakerLevel([1])).toBe(2);
    expect(nextCircuitBreakerLevel([1, 2, 3])).toBeNull();
    // Queda de 25% sem nada disparado ainda é o nível 1.
    expect(evaluateCircuitBreaker({ ...base, change: d('-0.25') })).toBe(1);
    expect(evaluateCircuitBreaker({ ...base, change: d('-0.12'), triggered: [1] })).toBeNull();
    expect(evaluateCircuitBreaker({ ...base, change: d('-0.15'), triggered: [1] })).toBe(2);
    expect(evaluateCircuitBreaker({ ...base, change: d('-0.5'), triggered: [1, 2, 3] })).toBeNull();
  });
});

describe('RN-FCH: fechamento', () => {
  it('RN-FCH-001: precedência entre call, último negócio e fechamento anterior', () => {
    const all = { closingCall: d('11'), lastContinuousTrade: d('10.5'), previousClose: d('10') };
    expect(closingPrice(all)).toEqual({ price: d('11'), source: 'CLOSING_CALL' });
    expect(closingPrice({ ...all, closingCall: null })).toEqual({
      price: d('10.5'),
      source: 'LAST_TRADE',
    });
    expect(closingPrice({ ...all, closingCall: null, lastContinuousTrade: null })).toEqual({
      price: d('10'),
      source: 'PREVIOUS_CLOSE',
    });
    expect(
      closingPrice({ closingCall: null, lastContinuousTrade: null, previousClose: null }),
    ).toBeNull();
  });

  it('RN-FCH-003: alerta só acima do limite', () => {
    expect(closeDiverges(d('10.5'), d('10'), d('0.05'))).toBe(false);
    expect(closeDiverges(d('10.51'), d('10'), d('0.05'))).toBe(true);
    expect(closeDiverges(d('9.49'), d('10'), d('0.05'))).toBe(true);
  });
});

describe('parâmetros e motivos', () => {
  it('Ativos §7: a sobrescrita vale só nos campos que traz', () => {
    const rules = resolveRules({ staticAuctionBandPct: '0.10' }, { auctionRandomEndMaxS: 10 });
    expect(rules).toMatchObject({
      staticAuctionBandPct: '0.10',
      auctionRandomEndMaxS: 10,
      dynamicAuctionBandPct: '0.03',
    });
  });

  it('RN-INS-020/021: motivo da suspensão pelo status do cadastro', () => {
    expect(haltReasonOfStatus('STALE_REFERENCE_PRICE')).toBe('STALE_REFERENCE_PRICE');
    expect(haltReasonOfStatus('CORPORATE_ACTION_SPLIT')).toBe('CORPORATE_ACTION');
    expect(haltReasonOfStatus('BACKOFFICE')).toBe('INSTRUMENT_SUSPENDED');
  });
});
