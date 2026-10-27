import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
import { BusinessDate, Instant } from '@broker/domain-kernel';
import { describe, expect, it } from 'vitest';
import { decide } from '../src/domain/acceptance.js';
import {
  assessBudget,
  DEFAULT_BUDGET_POLICY,
  levelAllows,
  maxUniverseSize,
  universeIntervalMs,
} from '../src/domain/budget.js';
import { CircuitBreaker } from '../src/domain/circuit-breaker.js';
import { Prng, seedState } from '../src/domain/prng.js';
import { quoteWarnings, type ExternalQuote } from '../src/domain/quote.js';
import {
  DEFAULT_SYNTHETIC,
  ReferencePriceModel,
  referenceSeed,
  sigmaPerTick,
  type ReferenceUpdate,
} from '../src/domain/reference-price.js';
import { insideWindow, isStale, nextRead, phaseAt, quoteWindow } from '../src/domain/schedule.js';

const calendar = new TradingCalendar(b3Calendar2026To2027);
const at = (iso: string) => Instant.parse(iso);
const MIN = 60_000;

describe('orçamento (RN-BRP-030..035)', () => {
  const usage = {
    planName: 'free',
    planLimit: 15_000,
    currentUsage: 4000,
    remaining: 11_000,
    window: {
      type: 'BILLING_CYCLE' as const,
      start: at('2026-10-10T03:00:00Z'),
      end: at('2026-11-10T03:00:00Z'),
    },
  };
  const base = {
    now: at('2026-10-27T13:00:00Z'),
    policy: DEFAULT_BUDGET_POLICY,
    usage,
    sentSinceUsage: 0,
    quotaExhausted: false,
    businessDaysBetween: (a: BusinessDate, b: BusinessDate) => calendar.businessDaysBetween(a, b),
  };

  it('RN-BRP-031: orçamento diário com reserva proporcional e 95% nos dias úteis', () => {
    const a = assessBudget(base);
    // 27/10 a 10/11: 15 dias corridos; 10 dias úteis (2/11 é feriado de Finados).
    expect(a.reserve).toBe(Math.floor((0.2 * 15_000 * 15) / 31));
    expect(a.available).toBe(11_000 - a.reserve);
    expect(a.businessDayBudget).toBe(Math.floor((a.available * 0.95) / 10));
    expect(a.nonBusinessDayBudget).toBe(Math.floor((a.available * 0.05) / 5));
    expect(a.level).toBe('NORMAL');
  });

  it('RN-BRP-032: o enviado depois do E9 desconta do restante', () => {
    expect(assessBudget({ ...base, sentSinceUsage: 100 }).remaining).toBe(10_900);
  });

  it('níveis: SAVING pela projeção, CRITICAL com ≤ 5% e EXHAUSTED com 429 por cota', () => {
    // 12.000 usados em 17 dias: o ritmo esgota antes de 10/11.
    expect(assessBudget({ ...base, usage: { ...usage, remaining: 3000 } }).level).toBe('SAVING');
    expect(assessBudget({ ...base, usage: { ...usage, remaining: 750 } }).level).toBe('CRITICAL');
    expect(assessBudget({ ...base, quotaExhausted: true }).level).toBe('EXHAUSTED');
    expect(assessBudget({ ...base, usage: { ...usage, remaining: 0 } }).level).toBe('EXHAUSTED');
  });

  it('Brapi §5.3: o que cada nível deixa enviar', () => {
    expect(levelAllows('SAVING', 'ON_DEMAND_QUOTE', 3)).toBe(false);
    expect(levelAllows('SAVING', 'HISTORY', 4)).toBe(false);
    expect(levelAllows('SAVING', 'QUOTE', 1)).toBe(true);
    expect(levelAllows('CRITICAL', 'QUOTE', 0)).toBe(true);
    expect(levelAllows('CRITICAL', 'QUOTE', 1)).toBe(false);
    expect(levelAllows('CRITICAL', 'INDEX_QUOTE', 2)).toBe(false);
    expect(levelAllows('EXHAUSTED', 'QUOTE', 0)).toBe(false);
    expect(levelAllows('EXHAUSTED', 'USAGE', 5)).toBe(true);
    expect(universeIntervalMs('SAVING', 30 * MIN)).toBe(60 * MIN);
    expect(universeIntervalMs('NORMAL', 30 * MIN)).toBe(30 * MIN);
  });

  it('RN-BRP-033: o teto do universo com os padrões é 20', () => {
    expect(maxUniverseSize(15_000, 15, 22)).toBe(20);
    expect(maxUniverseSize(150_000, 15, 22)).toBe(204);
  });
});

describe('agendamento adaptativo (RN-BRP-050..053)', () => {
  it('RN-BRP-050: próxima leitura em quote_time + intervalo + folga, ou +5 min sem mudança (3×)', () => {
    const now = at('2026-10-27T14:00:00Z');
    const q = at('2026-10-27T13:55:00Z');
    expect(
      nextRead({
        now,
        previousQuoteTime: null,
        quoteTime: q,
        unchangedRetries: 0,
        updateIntervalMs: 30 * MIN,
        jitterMs: 90_000,
      }).nextReadAt.toString(),
    ).toBe('2026-10-27T14:26:30.000Z');
    let s = { unchangedRetries: 0 };
    for (let i = 1; i <= 3; i++) {
      const r = nextRead({
        now,
        previousQuoteTime: q,
        quoteTime: q,
        unchangedRetries: s.unchangedRetries,
        updateIntervalMs: 30 * MIN,
        jitterMs: 90_000,
      });
      expect(r.nextReadAt.toString()).toBe('2026-10-27T14:05:00.000Z');
      expect(r.unchangedRetries).toBe(i);
      s = r;
    }
    const back = nextRead({
      now,
      previousQuoteTime: q,
      quoteTime: q,
      unchangedRetries: 3,
      updateIntervalMs: 30 * MIN,
      jitterMs: 90_000,
    });
    expect(back.unchangedRetries).toBe(0);
    expect(back.nextReadAt.toString()).toBe('2026-10-27T14:31:30.000Z');
  });

  it('RN-BRP-051/053: janela 10:05–17:00 no dia útil e nenhuma no sábado', () => {
    const w = quoteWindow(calendar.sessionSchedule(BusinessDate.parse('2026-10-27')));
    expect(w!.from.toString()).toBe('2026-10-27T13:05:00.000Z');
    expect(w!.to.toString()).toBe('2026-10-27T20:00:00.000Z');
    expect(quoteWindow(calendar.sessionSchedule(BusinessDate.parse('2026-10-31')))).toBeNull();
    expect(insideWindow(null, at('2026-10-31T14:00:00Z'))).toBe(false);
    expect(
      phaseAt(
        calendar.sessionSchedule(BusinessDate.parse('2026-10-27')),
        at('2026-10-27T14:00:00Z'),
      ),
    ).toBe('CONTINUOUS');
  });

  it('RN-BRP-070: defasada com 50 min no pregão, contando a partir da abertura da janela', () => {
    const now = at('2026-10-27T15:00:00Z');
    expect(
      isStale({
        now,
        quoteTime: at('2026-10-27T14:10:00Z'),
        updateIntervalMs: 30 * MIN,
        inSession: true,
      }),
    ).toBe(true);
    expect(
      isStale({
        now,
        quoteTime: at('2026-10-27T14:20:00Z'),
        updateIntervalMs: 30 * MIN,
        inSession: true,
      }),
    ).toBe(false);
    expect(
      isStale({
        now,
        quoteTime: at('2026-10-27T14:10:00Z'),
        updateIntervalMs: 30 * MIN,
        inSession: false,
      }),
    ).toBe(false);
    // Fechamento de ontem às 10:20: só conta desde 10:05.
    expect(
      isStale({
        now: at('2026-10-27T13:20:00Z'),
        quoteTime: at('2026-10-26T21:00:00Z'),
        updateIntervalMs: 30 * MIN,
        inSession: true,
        sessionStart: at('2026-10-27T13:05:00Z'),
      }),
    ).toBe(false);
  });
});

describe('aceitação, quarentena e ordem (RN-BRP-071/072)', () => {
  const last = { price: '38.00', quoteTime: at('2026-10-27T14:00:00Z') };
  const input = { last, quarantined: null, jumpAlertPct: '0.05', corporateActionKnown: false };

  it('RN-BRP-072: leitura fora de ordem é descartada; a mesma é UNCHANGED', () => {
    expect(
      decide({ ...input, reading: { price: '38.10', quoteTime: at('2026-10-27T13:30:00Z') } })
        .disposition,
    ).toBe('DISCARDED_OUT_OF_ORDER');
    expect(
      decide({ ...input, reading: { price: '38.00', quoteTime: last.quoteTime } }).disposition,
    ).toBe('UNCHANGED');
  });

  it('RN-BRP-071: salto de 8% vai para a quarentena; a seguinte consistente libera', () => {
    const jump = { price: '41.04', quoteTime: at('2026-10-27T14:30:00Z') };
    const d1 = decide({ ...input, reading: jump });
    expect(d1.disposition).toBe('QUARANTINED');
    expect(d1.jumpPct).toBe('0.080000');
    const d2 = decide({
      ...input,
      quarantined: jump,
      reading: { price: '41.20', quoteTime: at('2026-10-27T15:00:00Z') },
    });
    expect(d2).toMatchObject({
      disposition: 'ACCEPTED',
      releasedFromQuarantine: true,
      clearQuarantine: true,
    });
    // A seguinte voltou para perto da âncora: a quarentena cai sem liberar o salto.
    const d3 = decide({
      ...input,
      quarantined: jump,
      reading: { price: '38.20', quoteTime: at('2026-10-27T15:00:00Z') },
    });
    expect(d3).toMatchObject({
      disposition: 'ACCEPTED',
      releasedFromQuarantine: false,
      clearQuarantine: true,
    });
  });

  it('evento corporativo conhecido aceita o salto direto', () => {
    expect(
      decide({
        ...input,
        corporateActionKnown: true,
        reading: { price: '19.00', quoteTime: at('2026-10-27T14:30:00Z') },
      }).disposition,
    ).toBe('ACCEPTED');
  });

  it('avisos de consistência (Brapi §9.1)', () => {
    const q = {
      lastPrice: '53.88',
      low: '51.17',
      high: '54.23',
      previousClose: '58.68',
      changePercent: '-8.18',
    } as ExternalQuote;
    expect(quoteWarnings(q)).toEqual([]);
    expect(quoteWarnings({ ...q, high: '53.00' }).map((w) => w.code)).toEqual(['OUT_OF_DAY_RANGE']);
    expect(quoteWarnings({ ...q, changePercent: '-5.00' }).map((w) => w.code)).toEqual([
      'CHANGE_MISMATCH',
    ]);
  });
});

describe('disjuntor (RN-BRP-080)', () => {
  it('abre após 5 falhas seguidas, meia-abertura com 1 requisição depois de 2 min', () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 4; i++) b.onFailure(1000);
    expect(b.state(1000)).toBe('CLOSED');
    b.onFailure(1000);
    expect(b.state(1000)).toBe('OPEN');
    expect(b.tryAcquire(60_000)).toBe(false);
    expect(b.state(121_000)).toBe('HALF_OPEN');
    expect(b.tryAcquire(121_000)).toBe(true);
    expect(b.tryAcquire(121_000)).toBe(false);
    b.onFailure(122_000);
    expect(b.state(122_000)).toBe('OPEN');
    expect(b.tryAcquire(242_000)).toBe(true);
    b.onSuccess();
    expect(b.state(242_000)).toBe('CLOSED');
  });
});

describe('gerador semeado (ADR-0009)', () => {
  it('mesma semente, mesma sequência; o estado retoma de onde parou', () => {
    const a = Prng.fromSeed('local|x|2026-10-27');
    const b = Prng.fromSeed('local|x|2026-10-27');
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    const c = new Prng(a.state());
    expect(c.next()).toBe(a.next());
    expect(seedState('a')).not.toEqual(seedState('b'));
    const r = Prng.fromSeed('ints');
    for (let i = 0; i < 100; i++) expect(r.int(2000, 10_000)).toBeGreaterThanOrEqual(2000);
  });
});

describe('preço de referência (Brapi §8, RN-SYN-001..004/006)', () => {
  const date = BusinessDate.parse('2026-10-27');
  const window = { from: date.atLocalTime('10:00'), to: date.atLocalTime('16:55') };
  const open = (params = DEFAULT_SYNTHETIC) =>
    ReferencePriceModel.open({
      seed: referenceSeed('test', 'inst-1', '2026-10-27'),
      instrumentId: 'inst-1',
      tradingDate: '2026-10-27',
      anchor: '38.4500',
      externalQuoteTime: null,
      at: date.atLocalTime('00:00'),
      previousSeq: 0,
      params,
      window,
      sigma: 0.0005,
    });

  /** O dia com âncoras às 11:00 e 13:30, avançado em passos de `stepMs`. */
  function day(stepMs: number): ReferenceUpdate[] {
    const m = open();
    const out: ReferenceUpdate[] = [];
    const anchors = new Map([
      [date.atLocalTime('11:00').epochMillis, '38.7000'],
      [date.atLocalTime('13:30').epochMillis, '38.5500'],
    ]);
    for (
      let t = date.atLocalTime('09:00').epochMillis;
      t <= date.atLocalTime('15:00').epochMillis;
      t += stepMs
    ) {
      for (const [when, price] of anchors) {
        if (when <= t && when > t - stepMs) {
          out.push(
            ...m.onAnchor(
              price,
              Instant.ofEpochMillis(when).toString(),
              Instant.ofEpochMillis(when),
            ),
          );
        }
      }
      out.push(...m.advance(Instant.ofEpochMillis(t)));
    }
    out.push(...m.advance(date.atLocalTime('15:00')));
    return out;
  }

  it('RN-SYN-002: o dia reprocessado com a mesma semente e âncoras é idêntico, qualquer ritmo', () => {
    const a = day(1000);
    const b = day(37_000);
    expect(a.length).toBeGreaterThan(1000);
    expect(b.map((u) => [u.at.toString(), u.price, u.origin])).toEqual(
      a.map((u) => [u.at.toString(), u.price, u.origin]),
    );
  });

  it('ruído limitado a ±0,30% da âncora, só no contínuo; glide linear em passos de 15 s', () => {
    const updates = day(5000);
    for (const u of updates) {
      const dev = Math.abs(Number(u.price) / Number(u.anchorPrice) - 1);
      // Até ±0,30%, mais o arredondamento a 4 casas.
      expect(dev).toBeLessThanOrEqual(0.003 + 1e-5);
      expect(u.at.isBefore(window.from)).toBe(false);
      expect(u.price).toMatch(/^\d+\.\d{4}$/);
    }
    const glide = updates.filter((u) => u.origin === 'GLIDE');
    expect(glide.length).toBe(20 + 20);
    expect(glide[0]!.anchorPrice).toBe('38.4625');
    expect(glide[19]!.anchorPrice).toBe('38.7000');
    expect(updates.some((u) => u.origin === 'SYNTHETIC_NOISE')).toBe(true);
  });

  it('RN-SYN-001: fora do contínuo a referência é a âncora, sem ruído', () => {
    const m = open();
    m.advance(date.atLocalTime('12:00'));
    const after = m.advance(date.atLocalTime('17:30'));
    const last = after[after.length - 1]!;
    expect(last.at.toString()).toBe(window.to.toString());
    expect(last.price).toBe('38.4500');
    expect(m.advance(date.atLocalTime('18:00'))).toEqual([]);
    const post = m.onAnchor('38.9000', '2026-10-27T21:00:00.000Z', date.atLocalTime('18:00'));
    expect(post).toHaveLength(1);
    expect(post[0]).toMatchObject({ origin: 'BRAPI', price: '38.9000' });
  });

  it('RN-SYN-004: ruído desligado publica só a âncora e o glide', () => {
    const m = open({ ...DEFAULT_SYNTHETIC, noiseEnabled: false });
    expect(m.advance(date.atLocalTime('12:00'))).toEqual([]);
    const u = m.onAnchor('39.0000', 'x', date.atLocalTime('12:00'));
    const g = [...u, ...m.advance(date.atLocalTime('12:10'))];
    expect(g.every((x) => x.origin === 'GLIDE')).toBe(true);
    expect(g[g.length - 1]!.price).toBe('39.0000');
  });

  it('RN-SYN-006: dentro do override todo valor é MANUAL com o preço fixado', () => {
    const m = open();
    const o = [
      { price: '30.0000', from: date.atLocalTime('11:00'), until: date.atLocalTime('11:10') },
    ];
    const u = m.advance(date.atLocalTime('11:20'), o);
    const inside = u.filter((x) => !x.at.isBefore(o[0]!.from) && x.at.isBefore(o[0]!.until));
    expect(inside.length).toBeGreaterThan(10);
    expect(inside.every((x) => x.origin === 'MANUAL' && x.price === '30.0000')).toBe(true);
    expect(inside[0]!.at.toString()).toBe(o[0]!.from.toString());
    const edge = u.find((x) => x.at.equals(o[0]!.until))!;
    expect(edge.origin).not.toBe('MANUAL');
  });

  it('emitFrom: o atraso não publicado evolui o mesmo estado', () => {
    const a = open();
    const b = open();
    a.advance(date.atLocalTime('12:00'));
    const skipped = b.advance(date.atLocalTime('12:00'), [], {
      emitFrom: date.atLocalTime('11:59'),
    });
    expect(skipped.every((u) => !u.at.isBefore(date.atLocalTime('11:59')))).toBe(true);
    expect(b.state().noise).toBe(a.state().noise);
    expect(b.state().rng).toEqual(a.state().rng);
  });

  it('sigma a partir da volatilidade dos fechamentos, mínimo 1 bp', () => {
    expect(sigmaPerTick(['10'])).toBe(0.0001);
    const s = sigmaPerTick(['53.88', '58.68', '57.83', '55.00', '56.10', '54.20']);
    expect(s).toBeGreaterThan(0.0001);
    expect(s).toBeLessThan(0.01);
  });
});
