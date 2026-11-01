import { EngineBandUpdateV1 } from '@broker/contracts/events/engine.band_update/v1';
import { EngineCancelOrderV1 } from '@broker/contracts/events/engine.cancel_order/v1';
import { EngineNewOrderV1 } from '@broker/contracts/events/engine.new_order/v1';
import { EngineNotesCutoffV1 } from '@broker/contracts/events/engine.notes_cutoff/v1';
import { EnginePhaseChangeV1 } from '@broker/contracts/events/engine.phase_change/v1';
import { EngineReplaceOrderV1 } from '@broker/contracts/events/engine.replace_order/v1';
import { EngineTradeBustV1 } from '@broker/contracts/events/engine.trade_bust/v1';
import { validationErrors, type Envelope, type EventDefinition } from '@broker/messaging';
import type {
  BandUpdateCommand,
  EngineCommand,
  NewOrderCommand,
  PhaseChangeCommand,
  ReplaceOrderCommand,
} from '../domain/inputs.js';
import { parsePrice } from '../domain/price.js';

export interface DecodedCommand {
  instrumentId: string;
  command: EngineCommand;
}

export class InvalidCommandError extends Error {}

type Payload = Record<string, unknown>;

interface Route {
  definition: EventDefinition;
  instrumentId: (p: Payload) => string;
  command: (p: Payload) => EngineCommand;
}

const byInstrument = (p: Payload) => p['instrumentId'] as string;

function strip<T extends object>(kind: string, p: Payload, drop: string): T {
  const { [drop]: _dropped, ...rest } = p;
  return { kind, ...rest } as unknown as T;
}

const ROUTES: Readonly<Record<string, Route>> = {
  'engine.new_order': {
    definition: EngineNewOrderV1,
    instrumentId: byInstrument,
    command: (p) => {
      const order = strip<NewOrderCommand>('NewOrder', p, 'instrumentId');
      assertOrder(order);
      return order;
    },
  },
  'engine.cancel_order': {
    definition: EngineCancelOrderV1,
    instrumentId: byInstrument,
    command: (p) => ({
      kind: 'CancelOrder',
      orderId: p['orderId'] as string,
      reason: p['reason'] as string,
    }),
  },
  'engine.replace_order': {
    definition: EngineReplaceOrderV1,
    instrumentId: byInstrument,
    command: (p) => {
      const replace = strip<ReplaceOrderCommand>('ReplaceOrder', p, 'instrumentId');
      if (replace.newLimitPrice !== undefined) assertPrice(replace.newLimitPrice);
      return replace;
    },
  },
  'engine.phase_change': {
    definition: EnginePhaseChangeV1,
    instrumentId: (p) => p['scope'] as string,
    command: (p) => strip<PhaseChangeCommand>('PhaseChange', p, 'scope'),
  },
  'engine.band_update': {
    definition: EngineBandUpdateV1,
    instrumentId: byInstrument,
    command: (p) => strip<BandUpdateCommand>('BandUpdate', p, 'instrumentId'),
  },
  'engine.trade_bust': {
    definition: EngineTradeBustV1,
    instrumentId: byInstrument,
    command: (p) => ({
      kind: 'TradeBust',
      tradeId: p['tradeId'] as string,
      approvalRequestId: p['approvalRequestId'] as string,
    }),
  },
  'engine.notes_cutoff': {
    definition: EngineNotesCutoffV1,
    instrumentId: byInstrument,
    command: (p) => ({ kind: 'NotesCutoff', tradingDate: p['tradingDate'] as string }),
  },
};

function assertPrice(text: string): void {
  try {
    if (parsePrice(text) <= 0) throw new Error('não positivo');
  } catch {
    throw new InvalidCommandError(`preço inválido: ${text}`);
  }
}

/** O que o esquema não expressa. Vale antes do journal: depois dele, a entrada será reprocessada. */
function assertOrder(o: NewOrderCommand): void {
  if (o.type === 'LIMIT' && o.limitPrice === undefined)
    throw new InvalidCommandError('ordem LIMIT sem limitPrice');
  if (o.type === 'MARKET' && o.limitPrice !== undefined)
    throw new InvalidCommandError('ordem MARKET com limitPrice');
  if (o.limitPrice !== undefined) assertPrice(o.limitPrice);
  if (o.protectionPrice !== undefined) assertPrice(o.protectionPrice);
  if (o.displayQuantity !== undefined && o.displayQuantity > o.quantity)
    throw new InvalidCommandError('displayQuantity maior que a quantidade');
}

/**
 * Traduz um comando do barramento para o domínio. Devolve `null` para tipo ou versão que este Motor
 * não trata (tolerant reader, RN-MSG-B-021) e falha com `InvalidCommandError` para o resto.
 */
export function decodeCommand(envelope: Envelope): DecodedCommand | null {
  const route = ROUTES[envelope.eventType];
  if (!route || route.definition.eventVersion !== envelope.eventVersion) return null;
  const errors = validationErrors(route.definition.payload, envelope.payload);
  if (errors.length > 0)
    throw new InvalidCommandError(`${envelope.eventType} inválido: ${errors.join('; ')}`);
  return {
    instrumentId: route.instrumentId(envelope.payload),
    command: route.command(envelope.payload),
  };
}
