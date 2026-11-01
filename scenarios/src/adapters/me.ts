import { Instant } from '@broker/domain-kernel';
import { InstrumentEngine } from '@broker/matching-engine/domain/engine';
import type {
  EngineCommand,
  EngineInput,
  EngineOutput,
  Phase,
} from '@broker/matching-engine/domain/inputs';
import type { ScenarioAdapter } from '../runner.js';

interface MeCommand {
  /** Segundos desde o início do relógio do cenário. */
  t: number;
  cmd: string;
  id?: string;
  side?: 'BUY' | 'SELL';
  type?: 'LIMIT' | 'MARKET';
  qty?: number;
  price?: string;
  account?: string;
  board?: 'MAIN' | 'ODD_LOT';
  tif?: 'DAY' | 'GTC' | 'GTD' | 'IOC' | 'FOK';
  protection?: string;
  display?: number;
  stp?: 'CANCEL_AGGRESSOR' | 'CANCEL_RESTING' | 'CANCEL_BOTH';
  participant?: 'CUSTOMER' | 'MARKET_MAKER' | 'SYSTEM';
  reason?: string;
  version?: number;
  fase?: Phase;
  auction_id?: string;
  auction_type?: 'OPENING' | 'CLOSING' | 'VOLATILITY' | 'REOPENING';
  /** Segundos até o fim previsto. */
  auction_end_t?: number;
  seed?: string;
  concludes?: string;
  price_limit?: { min: string; max: string };
  referencia?: string;
}

interface MeInputs {
  instrumento?: {
    band_reference_price?: string;
    rejection_band_pct?: string;
    static_auction_band_pct?: string;
    dynamic_auction_band_pct?: string;
    volatility_auction_duration_s?: number;
    auction_random_end_max_s?: number;
  };
  fase?: Phase;
  comandos: MeCommand[];
  /** ME-012: restaura de um snapshot tirado depois de N comandos e reprocessa o resto. */
  recuperacao?: { snapshot_apos: number };
  /** ME-013: roda duas vezes e confere se o fim efetivo é o mesmo. */
  repetir?: boolean;
}

const INSTRUMENT = 'TEST3';

/** Instante e data do cenário; o Motor nunca lê o relógio (RN-ME-002). */
function stamp(start: Instant, t: number) {
  const at = start.plusMillis(t * 1000);
  return { ts: at.epochMillis, tradingDate: at.businessDate().toString() };
}

function toCommand(c: MeCommand, start: Instant): EngineCommand {
  switch (c.cmd) {
    case 'NewOrder':
      return {
        kind: 'NewOrder',
        orderId: c.id!,
        accountId: c.account!,
        participantType: c.participant ?? 'CUSTOMER',
        board: c.board ?? 'MAIN',
        side: c.side!,
        type: c.type ?? 'LIMIT',
        quantity: c.qty!,
        ...(c.price !== undefined ? { limitPrice: c.price } : {}),
        ...(c.protection !== undefined ? { protectionPrice: c.protection } : {}),
        timeInForce: c.tif ?? 'DAY',
        ...(c.display !== undefined ? { displayQuantity: c.display } : {}),
        stpPolicy: c.stp ?? 'CANCEL_AGGRESSOR',
      };
    case 'CancelOrder':
      return { kind: 'CancelOrder', orderId: c.id!, reason: c.reason ?? 'CUSTOMER_REQUEST' };
    case 'ReplaceOrder':
      return {
        kind: 'ReplaceOrder',
        orderId: c.id!,
        ...(c.qty !== undefined ? { newQuantity: c.qty } : {}),
        ...(c.price !== undefined ? { newLimitPrice: c.price } : {}),
        expectedVersion: c.version ?? 1,
      };
    case 'PhaseChange':
      return {
        kind: 'PhaseChange',
        phase: c.fase!,
        ...(c.auction_id ? { auctionId: c.auction_id } : {}),
        ...(c.auction_type ? { auctionType: c.auction_type } : {}),
        ...(c.auction_end_t !== undefined
          ? { auctionEndAt: start.plusMillis(c.auction_end_t * 1000).toString() }
          : {}),
        ...(c.seed !== undefined ? { randomSeed: c.seed } : {}),
        ...(c.concludes ? { concludesAuctionId: c.concludes } : {}),
        ...(c.price_limit ? { priceLimit: c.price_limit } : {}),
      };
    case 'Tick':
      return { kind: 'Tick' };
    case 'TradeBust':
      return { kind: 'TradeBust', tradeId: c.id!, approvalRequestId: 'APR' };
    default:
      throw new Error(`comando ME desconhecido: ${c.cmd}`);
  }
}

function buildInputs(inputs: MeInputs, start: Instant, seed: number): EngineInput[] {
  const list: EngineInput[] = [];
  const push = (t: number, command: EngineCommand) =>
    list.push({ inputSeq: list.length + 1, ...stamp(start, t), seed, command });
  const i = inputs.instrumento;
  if (i?.band_reference_price)
    push(0, {
      kind: 'BandUpdate',
      bandReferencePrice: i.band_reference_price,
      rejectionBandPct: i.rejection_band_pct ?? '0.20',
      staticAuctionBandPct: i.static_auction_band_pct ?? '0.08',
      dynamicAuctionBandPct: i.dynamic_auction_band_pct ?? '0.03',
      volatilityAuctionDurationS: i.volatility_auction_duration_s ?? 300,
      auctionRandomEndMaxS: i.auction_random_end_max_s ?? 30,
    });
  push(0, { kind: 'PhaseChange', phase: inputs.fase ?? 'CONTINUOUS' });
  for (const c of inputs.comandos) push(c.t, toCommand(c, start));
  return list;
}

function describe(outputs: readonly EngineOutput[], start: Instant) {
  const trades = [];
  const canceladas = [];
  const rejeitadas = [];
  const leiloes = [];
  for (const o of outputs) {
    const p = o.payload;
    switch (o.eventType) {
      case 'engine.trade_executed':
        trades.push({
          buy: p['buyOrderId'],
          sell: p['sellOrderId'],
          price: p['price'],
          qty: p['quantity'],
          ...(o.board === 'MAIN' ? {} : { board: o.board }),
          ...(p['aggressorSide'] === 'NONE' ? { auction: p['auctionId'] } : {}),
        });
        break;
      case 'engine.order_canceled':
        canceladas.push({ id: p['orderId'], qty: p['canceledQuantity'], reason: p['reason'] });
        break;
      case 'engine.order_rejected':
        rejeitadas.push({ id: p['orderId'], reason: p['reason'] });
        break;
      case 'engine.auction_triggered':
        leiloes.push({
          evento: 'INICIO',
          tipo: p['type'],
          motivo: p['reason'],
          fim_previsto_t: secondsFrom(start, p['expectedEndAt'] as string),
        });
        break;
      case 'engine.auction_completed':
        if (o.board === 'MAIN')
          leiloes.push({
            evento: 'FIM',
            price: p['price'],
            qty: p['quantity'],
            fim_efetivo_t: (o.ts - start.epochMillis) / 1000,
          });
        break;
    }
  }
  return { trades, canceladas, rejeitadas, leiloes };
}

const secondsFrom = (start: Instant, iso: string) =>
  (Instant.parse(iso).epochMillis - start.epochMillis) / 1000;

/** Motor (ME-*): sequência de comandos → negócios, ordens encerradas, livro final e fase (Motor §2–§8). */
export const meAdapter: ScenarioAdapter = (raw, ctx) => {
  const inputs = raw as MeInputs;
  const start = ctx.clock.now();
  const seed = ctx.random.int(0, 2 ** 31);
  const list = buildInputs(inputs, start, seed);
  const engine = new InstrumentEngine(INSTRUMENT);
  const outputs = list.flatMap((input) => engine.process(input));

  const { trades, canceladas, rejeitadas, leiloes } = describe(outputs, start);
  const odd = engine.bookView('ODD_LOT');
  const oddEmpty = odd.bids.length === 0 && odd.asks.length === 0;
  const result: Record<string, unknown> = {
    trades,
    ...(canceladas.length ? { canceladas } : {}),
    ...(rejeitadas.length ? { rejeitadas } : {}),
    ...(leiloes.length ? { leiloes } : {}),
    livro_final: engine.bookView('MAIN'),
    ...(oddEmpty ? {} : { livro_fracionario: odd }),
    fase: engine.phase,
  };

  if (inputs.recuperacao) {
    // Os comandos do cenário vêm depois das entradas de preparação (túneis e fase).
    const cut = list.length - inputs.comandos.length + inputs.recuperacao.snapshot_apos;
    const before = new InstrumentEngine(INSTRUMENT);
    const firstHalf = list.slice(0, cut).flatMap((input) => before.process(input));
    // Pelo JSON, como no banco: o que não sobrevive à serialização não é estado.
    const restored = InstrumentEngine.restore(JSON.parse(JSON.stringify(before.snapshot())));
    const regenerated = list.slice(cut).flatMap((input) => restored.process(input));
    result['recuperacao'] = {
      saidas_identicas: JSON.stringify([...firstHalf, ...regenerated]) === JSON.stringify(outputs),
      estado_identico: JSON.stringify(restored.snapshot()) === JSON.stringify(engine.snapshot()),
    };
  }
  if (inputs.repetir) {
    const again = new InstrumentEngine(INSTRUMENT);
    const second = list.flatMap((input) => again.process(input));
    result['reprodutivel'] = JSON.stringify(second) === JSON.stringify(outputs);
  }
  return result;
};
