// Semente do ambiente local (RN-ENV-031): histórico de preços dos instrumentos negociáveis, para o
// gráfico diário e para o provedor `replay` (Brapi §13). Idempotente: candle e leitura que já existem
// ficam como estão (o histórico real, quando chega, prevalece).
// Uso: node dist/seed.js (no contêiner do serviço, pelo `pnpm env:seed`, depois da semente do universo).
//
// Os preços partem da cotação gravada nas fixtures e fazem um passeio aleatório semeado pelo ticker:
// a mesma semente dá sempre o mesmo histórico, e o último fechamento é o preço da fixture.
import { b3Calendar2026To2027, TradingCalendar } from '@broker/calendar';
import { BusinessDate, Instant } from '@broker/domain-kernel';
import { createDatabase } from '@broker/persistence';
import { BaseConfigProperties, loadConfigOrExit } from '@broker/service-kit';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import Type from 'typebox';
import { loadFixtures } from './adapters/brapi/fixtures.js';
import { mapQuote } from './adapters/brapi/mapping.js';
import { Prng } from './domain/prng.js';
import type { ExternalQuote } from './domain/quote.js';

const Config = Type.Object({
  ...BaseConfigProperties,
  DB_HOST: Type.String(),
  DB_PORT: Type.Integer({ default: 5432 }),
  DB_NAME: Type.String(),
  DB_USER: Type.String(),
  DB_PASSWORD: Type.String(),
  REPLAY_OFFSET_DAYS: Type.Integer({ default: 7, minimum: 0 }),
  /** Dias úteis de candles diários. */
  SEED_HISTORY_DAYS: Type.Integer({ default: 120, minimum: 1 }),
});

const config = loadConfigOrExit(Config);
const db = createDatabase({
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
});
const calendar = new TradingCalendar(b3Calendar2026To2027);
/** Intervalo das leituras intradiárias (o `update_interval` do plano gratuito da brapi). */
const READING_EVERY_MS = 15 * 60_000;

const money = (v: number) => v.toFixed(2);

/** UUID estável por conteúdo: rodar de novo cai no `ON CONFLICT DO NOTHING`. */
function stableId(text: string): string {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Os instrumentos negociáveis chegam por `instrument.tradability_changed`: espera a lista assentar. */
async function tradableInstruments(): Promise<{ symbol: string; instrumentId: string }[]> {
  let previous = -1;
  for (let i = 0; i < 30; i++) {
    const { rows } = await sql<{ symbol: string; instrument_id: string }>`
      SELECT symbol, instrument_id FROM instrument_ref
      WHERE tradable AND status <> 'DELISTED' ORDER BY symbol`.execute(db);
    if (rows.length > 0 && rows.length === previous)
      return rows.map((r) => ({ symbol: r.symbol, instrumentId: r.instrument_id }));
    previous = rows.length;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return [];
}

interface Day {
  date: BusinessDate;
  open: number;
  close: number;
  /** Leituras do pregão contínuo (só nos dias que o replay pode pedir). */
  readings: { at: Instant; price: number }[];
}

/** Passeio aleatório diário que termina no preço da fixture, com leituras nos dias recentes. */
function pricePath(symbol: string, last: number, dates: BusinessDate[], recentFrom: BusinessDate) {
  const prng = Prng.fromSeed(`seed-history|${symbol}`);
  const step = (sd: number) => (prng.next() + prng.next() + prng.next() - 1.5) * 2 * sd;
  const closes: number[] = [];
  let level = 1;
  for (let i = 0; i < dates.length; i++) closes.push((level *= 1 + step(0.012)));
  const scale = last / closes[closes.length - 1]!;
  const days: Day[] = [];
  let prev = closes[0]! * scale * (1 - step(0.01));
  dates.forEach((date, i) => {
    const close = closes[i]! * scale;
    const open = prev * (1 + step(0.004));
    const readings: Day['readings'] = [];
    const continuous = calendar.sessionSchedule(date)?.phases.find((p) => p.phase === 'CONTINUOUS');
    if (continuous && !date.isBefore(recentFrom)) {
      const n = Math.floor(
        (continuous.endsAt.epochMillis - continuous.startsAt.epochMillis) / READING_EVERY_MS,
      );
      // Ponte browniana: sai da abertura e chega ao fechamento com ruído no meio do dia.
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const price = (open + (close - open) * t) * (1 + step(0.003) * Math.sqrt(t * (1 - t)));
        readings.push({ at: continuous.startsAt.plusMillis(k * READING_EVERY_MS), price });
      }
    }
    days.push({ date, open, close, readings });
    prev = close;
  });
  return days;
}

async function seedSymbol(
  symbol: string,
  instrumentId: string,
  now: Instant,
): Promise<{ candles: number; readings: number }> {
  const fixture = loadFixtures().find(
    (f) =>
      f.request.path.endsWith('/quote') &&
      f.request.query['symbols'] === symbol &&
      f.response.status === 200,
  );
  let base: ExternalQuote;
  try {
    base = mapQuote(fixture?.response.body, symbol);
  } catch {
    return { candles: 0, readings: 0 };
  }
  if (base.changed) return { candles: 0, readings: 0 };

  const today = now.businessDate();
  const dates: BusinessDate[] = [];
  for (let d = today.plusDays(-1); dates.length < config.SEED_HISTORY_DAYS; d = d.plusDays(-1))
    if (calendar.isBusinessDay(d)) dates.unshift(d);
  // O replay serve agora a leitura de `agora − offset`: cobre a próxima semana inteira.
  const recentFrom = today.plusDays(-(config.REPLAY_OFFSET_DAYS + 7));
  const days = pricePath(symbol, Number(base.lastPrice), dates, recentFrom);

  let candles = 0;
  let readings = 0;
  await db.transaction().execute(async (trx) => {
    for (const day of days) {
      const prices = [day.open, day.close, ...day.readings.map((r) => r.price)];
      const high = Math.max(...prices);
      const low = Math.min(...prices);
      const volume = Math.round(
        Number(base.volume ?? 10_000_000) * (0.6 + 0.8 * (day.close / high)),
      );
      const c = await sql`
        INSERT INTO external_daily_candle (symbol, date, open, high, low, close, adjusted_close, volume, source)
        VALUES (${symbol}, ${day.date.toString()}, ${money(day.open)}, ${money(high)}, ${money(low)},
                ${money(day.close)}, ${money(day.close)}, ${volume}, 'HISTORY')
        ON CONFLICT (symbol, date) DO NOTHING`.execute(trx);
      candles += Number(c.numAffectedRows ?? 0);

      let dayHigh = day.open;
      let dayLow = day.open;
      const previousClose = days[days.indexOf(day) - 1]?.close ?? day.open;
      for (const r of day.readings) {
        dayHigh = Math.max(dayHigh, r.price);
        dayLow = Math.min(dayLow, r.price);
        const quote = {
          ...base,
          lastPrice: money(r.price),
          quoteTime: r.at.toString(),
          open: money(day.open),
          high: money(dayHigh),
          low: money(dayLow),
          previousClose: money(previousClose),
          change: money(r.price - previousClose),
          changePercent: (((r.price - previousClose) / previousClose) * 100).toFixed(3),
        };
        // Leituras de fixture (provider `fixture`) também alimentam o replay no ambiente local.
        const h = await sql`
          INSERT INTO external_quote_history (id, symbol, instrument_id, provider, fetched_at, quote_time, data,
                                              raw_sha256, disposition)
          VALUES (${stableId(`${symbol}|${r.at.toString()}`)}, ${symbol}, ${instrumentId}, 'fixture',
                  ${r.at.toString()}, ${r.at.toString()}, ${JSON.stringify(quote)}, 'seed', 'ACCEPTED')
          ON CONFLICT (id) DO NOTHING`.execute(trx);
        readings += Number(h.numAffectedRows ?? 0);
      }
    }
  });
  return { candles, readings };
}

try {
  const instruments = await tradableInstruments();
  if (instruments.length === 0)
    console.log('nenhum instrumento negociável: rode antes a semente do reference-data');
  // Sem cotação completa nas fixtures (ex.: ELET3, ticker trocado), o ticker fica sem histórico.
  const now = Instant.ofEpochMillis(Date.now());
  for (const { symbol, instrumentId } of instruments) {
    const r = await seedSymbol(symbol, instrumentId, now);
    console.log(`${symbol}: ${r.candles} candles e ${r.readings} leituras novas`);
  }
} finally {
  await db.destroy();
}
