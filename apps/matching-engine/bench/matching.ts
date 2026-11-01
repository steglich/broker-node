// Benchmark do matching em memória (RNF-002, D12): `pnpm --filter @broker/matching-engine bench`.
// Mede só `InstrumentEngine.process` (entrada → saída), sem journal nem barramento. O fluxo imita um
// livro com o FMS cotando dos dois lados: ordens em repouso, agressões e cancelamentos.
import { InstrumentEngine } from '../src/domain/engine.js';
import type { EngineCommand, EngineInput } from '../src/domain/inputs.js';

const INPUTS = Number(process.argv[2] ?? 500_000);
const WARMUP = Math.min(50_000, Math.floor(INPUTS / 5));
const START = 1_767_000_000_000;

// PRNG local para o fluxo ser sempre o mesmo entre execuções.
let state = 42;
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (max: number) => Math.floor(random() * max);
const price = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

const engine = new InstrumentEngine('BENCH3');
let seq = 0;
let now = START;
const input = (command: EngineCommand): EngineInput => ({
  inputSeq: ++seq,
  ts: (now += 1),
  tradingDate: '2026-03-03',
  seed: 1,
  command,
});

engine.process(
  input({
    kind: 'BandUpdate',
    bandReferencePrice: '100.00',
    rejectionBandPct: '0.20',
    staticAuctionBandPct: '0.08',
    dynamicAuctionBandPct: '0.03',
    volatilityAuctionDurationS: 300,
    auctionRandomEndMaxS: 30,
  }),
);
engine.process(input({ kind: 'PhaseChange', phase: 'CONTINUOUS' }));

let nextOrder = 0;
const live: string[] = [];
function command(): EngineCommand {
  const roll = random();
  if (roll < 0.25 && live.length > 0) {
    const at = pick(live.length);
    const orderId = live[at]!;
    live[at] = live[live.length - 1]!;
    live.pop();
    return { kind: 'CancelOrder', orderId, reason: 'CUSTOMER_REQUEST' };
  }
  const side = random() < 0.5 ? 'BUY' : 'SELL';
  // 70% em repouso em volta do meio; 30% agressivas, cruzando o spread.
  const aggressive = roll > 0.7;
  const distance = aggressive ? -pick(3) : 1 + pick(50);
  const cents = 10_000 + (side === 'BUY' ? -distance : distance);
  const orderId = `O${++nextOrder}`;
  live.push(orderId);
  // Sem limitar `live`, os cancelamentos miram ordens já executadas e viram UNKNOWN_ORDER.
  if (live.length > 20_000) live.shift();
  return {
    kind: 'NewOrder',
    orderId,
    accountId: `A${pick(500)}`,
    participantType: 'CUSTOMER',
    board: 'MAIN',
    side,
    type: 'LIMIT',
    quantity: 100 * (1 + pick(5)),
    limitPrice: price(cents),
    timeInForce: 'DAY',
    stpPolicy: 'CANCEL_AGGRESSOR',
  };
}

const commands = Array.from({ length: INPUTS }, command);
const inputs = commands.map(input);
for (const i of inputs.slice(0, WARMUP)) engine.process(i);

const measured = inputs.slice(WARMUP);
const samples = new Float64Array(measured.length);
let outputs = 0;
const started = process.hrtime.bigint();
for (let i = 0; i < measured.length; i++) {
  const t0 = process.hrtime.bigint();
  outputs += engine.process(measured[i]!).length;
  samples[i] = Number(process.hrtime.bigint() - t0);
}
const elapsedNs = Number(process.hrtime.bigint() - started);
samples.sort();
const pct = (p: number) => samples[Math.floor((samples.length - 1) * p)]! / 1000;

console.log(
  JSON.stringify(
    {
      inputs: measured.length,
      outputs,
      throughputPerSecond: Math.round((measured.length / elapsedNs) * 1e9),
      latencyMicros: {
        p50: Number(pct(0.5).toFixed(1)),
        p99: Number(pct(0.99).toFixed(1)),
        p999: Number(pct(0.999).toFixed(1)),
        max: Number(pct(1).toFixed(1)),
      },
      node: process.version,
    },
    null,
    2,
  ),
);
