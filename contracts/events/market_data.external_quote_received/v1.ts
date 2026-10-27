import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';

const Dec = Type.String({ pattern: '^-?\\d+(\\.\\d+)?$' });
const OptDec = Type.Union([Dec, Type.Null()]);

export const MarketDataExternalQuoteReceivedV1 = defineEvent({
  eventType: 'market_data.external_quote_received',
  eventVersion: 1,
  payload: Type.Object({
    /** `null` para índices (Ibovespa, RN-MD-020) e tickers fora do cadastro. */
    instrumentId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    /** Ticker pedido (o do cadastro); `sourceSymbol` difere quando a fonte já trocou (RN-INS-033). */
    symbol: Type.String(),
    sourceSymbol: Type.String(),
    kind: Type.Union([Type.Literal('INSTRUMENT'), Type.Literal('INDEX')]),
    lastPrice: Dec,
    quoteTime: Type.String({ format: 'date-time' }),
    open: OptDec,
    high: OptDec,
    low: OptDec,
    previousClose: OptDec,
    change: OptDec,
    changePercent: OptDec,
    volume: OptDec,
    marketCap: OptDec,
    week52Low: OptDec,
    week52High: OptDec,
    currency: Type.Literal('BRL'),
    stale: Type.Boolean(),
    /** Provedor da leitura (`brapi`, `fixture`, `replay`), RN-BRP-003. */
    source: Type.String(),
    fetchedAt: Type.String({ format: 'date-time' }),
  }),
});

export default defineEventContract({
  definition: MarketDataExternalQuoteReceivedV1,
  producer: 'market-data-service',
  context: 'market-data',
  consumers: [
    'reference-data-service',
    'trading-session-service',
    'engagement-service',
    'realtime-gateway',
  ],
  summary:
    'Leitura externa aceita e normalizada (Brapi §9.1, RN-BRP-060); inclui o Ibovespa para o circuit breaker (RN-MD-021).',
});
