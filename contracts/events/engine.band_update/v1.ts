import { defineEvent } from '@broker/messaging';
import Type from 'typebox';
import { defineEventContract } from '../../src/define.js';
import { SessionPrice } from '../../src/schemas/session.js';

const Rate = Type.String({ pattern: '^\\d+(\\.\\d{1,8})?$' });

export const EngineBandUpdateV1 = defineEvent({
  eventType: 'engine.band_update',
  eventVersion: 1,
  payload: Type.Object({
    instrumentId: Type.String({ format: 'uuid' }),
    bandReferencePrice: SessionPrice,
    rejectionBandPct: Rate,
    staticAuctionBandPct: Rate,
    dynamicAuctionBandPct: Rate,
    volatilityAuctionDurationS: Type.Integer({ minimum: 1 }),
    auctionRandomEndMaxS: Type.Integer({ minimum: 0 }),
  }),
});

export default defineEventContract({
  definition: EngineBandUpdateV1,
  producer: 'trading-session-service',
  context: 'engine',
  kind: 'commands',
  consumers: ['matching-engine', 'market-maker-service'],
  summary:
    'Comando `BandUpdate`: referência dos túneis do pregão e regras de túnel (RN-INS-040, RN-FCH-002).',
});
