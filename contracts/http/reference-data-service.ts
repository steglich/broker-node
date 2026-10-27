import Type from 'typebox';
import { defineHttpContract } from '../src/define.js';
import {
  CalendarDataSchema,
  InstrumentState,
  TradingRulesValues,
} from '../src/schemas/reference.js';

const Uuid = Type.String({ format: 'uuid' });
const Date_ = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const Rate = Type.String({ pattern: '^\\d+(\\.\\d{1,8})?$' });
const IdParams = Type.Object({ id: Uuid });
const AssetType = Type.Union(['STOCK', 'UNIT', 'REIT', 'ETF', 'BDR'].map((t) => Type.Literal(t)));
const ShareClass = Type.Union(
  ['ON', 'PN', 'PNA', 'PNB', 'UNIT', 'N/A'].map((t) => Type.Literal(t)),
);
const TaxCategory = Type.Union(['STOCK', 'REIT', 'ETF_EQUITY', 'BDR'].map((t) => Type.Literal(t)));
const Justification = Type.String({ minLength: 3, maxLength: 1000 });

export const Instrument = Type.Object({
  ...InstrumentState.properties,
  statusReason: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
});

export const SearchResult = Type.Object({
  instrument: Instrument,
  board: Type.Union([Type.Literal('MAIN'), Type.Literal('ODD_LOT')]),
  /** Ticker do livro: `PETR4` ou `PETR4F`. */
  tradingSymbol: Type.String(),
  /** RN-INS-032: "Ticker alterado de X para Y em dd/mm/aaaa". */
  notice: Type.Optional(Type.String()),
});

const Attributes = Type.Partial(
  Type.Object({
    lotSize: Type.Integer({ minimum: 1 }),
    tickSize: Rate,
    shortSaleEnabled: Type.Boolean(),
    dayTradeEnabled: Type.Boolean(),
    collateralEligible: Type.Boolean(),
    haircut: Type.Union([Rate, Type.Null()]),
    taxCategory: TaxCategory,
    shareClass: ShareClass,
    isin: Type.Union([Type.String({ pattern: '^[A-Z]{2}[A-Z0-9]{10}$' }), Type.Null()]),
    shortName: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
    longName: Type.Union([Type.String({ maxLength: 250 }), Type.Null()]),
    sector: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
    subsector: Type.Union([Type.String({ maxLength: 120 }), Type.Null()]),
    logoUrl: Type.Union([Type.String({ format: 'uri' }), Type.Null()]),
  }),
  { additionalProperties: false },
);

export const TypeDefaults = Type.Object({
  assetType: AssetType,
  lotSize: Type.Integer({ minimum: 1 }),
  tickSize: Rate,
  shortSaleEnabled: Type.Boolean(),
  dayTradeEnabled: Type.Boolean(),
  collateralEligible: Type.Boolean(),
  haircut: Type.Union([Rate, Type.Null()]),
  taxCategory: TaxCategory,
});

export const ChangeRequest = Type.Object({
  id: Uuid,
  type: Type.Union(
    ['UNIVERSE_INCLUDE', 'UNIVERSE_REMOVE', 'TRADING_RULES', 'CALENDAR', 'SESSION_SCHEDULE'].map(
      (t) => Type.Literal(t),
    ),
  ),
  targetId: Type.String(),
  payload: Type.Record(Type.String(), Type.Unknown()),
  currentState: Type.Record(Type.String(), Type.Unknown()),
  justification: Type.String(),
  makerId: Type.String(),
  status: Type.Union(
    ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELED', 'STALE'].map((t) => Type.Literal(t)),
  ),
  createdAt: Type.String({ format: 'date-time' }),
  expiresAt: Type.String({ format: 'date-time' }),
  decidedBy: Type.Union([Type.String(), Type.Null()]),
  decidedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  decisionReason: Type.Union([Type.String(), Type.Null()]),
});

export const Task = Type.Object({
  id: Uuid,
  kind: Type.String(),
  instrumentId: Type.Union([Uuid, Type.Null()]),
  data: Type.Record(Type.String(), Type.Unknown()),
  status: Type.Union(['OPEN', 'DONE', 'DISMISSED'].map((t) => Type.Literal(t))),
  createdAt: Type.String({ format: 'date-time' }),
  resolvedBy: Type.Union([Type.String(), Type.Null()]),
  resolvedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

const Phase = Type.Object({
  phase: Type.Union(
    ['PRE_TRADING', 'PRE_OPENING', 'CONTINUOUS', 'CLOSING_CALL', 'POST_CLOSE', 'CLOSED'].map((p) =>
      Type.Literal(p),
    ),
  ),
  start: Type.String({ pattern: '^\\d{2}:\\d{2}$' }),
});

const Requested = { 201: { description: 'Solicitação PENDING criada.', body: ChangeRequest } };

export const referenceDataServiceHttp = defineHttpContract({
  service: 'reference-data-service',
  title: 'reference-data-service',
  version: '1.0.0',
  routes: {
    // ------------------------------------------------------------ instrumentos (consulta)
    searchInstruments: {
      method: 'get',
      path: '/v1/instruments/search',
      summary:
        'Busca por ticker (principal, fracionário ou antigo, com aviso) e nome (RN-INS-010, RN-INS-032).',
      auth: 'user',
      query: Type.Object({
        q: Type.String({ minLength: 1, maxLength: 60 }),
        limit: Type.Optional(Type.String({ pattern: '^\\d+$' })),
      }),
      responses: {
        200: { description: 'Resultados.', body: Type.Object({ items: Type.Array(SearchResult) }) },
      },
    },
    resolveSymbol: {
      method: 'get',
      path: '/v1/instruments/by-symbol/:symbol',
      summary: 'Resolve um ticker exato: PETR4F → PETR4 no ODD_LOT; ticker antigo com aviso.',
      auth: 'user',
      params: Type.Object({ symbol: Type.String({ pattern: '^[A-Za-z0-9]{2,12}$' }) }),
      responses: {
        200: { description: 'Instrumento e livro.', body: SearchResult },
        404: { description: 'INSTRUMENT_NOT_FOUND.' },
      },
    },
    listInstruments: {
      method: 'get',
      path: '/v1/instruments',
      summary: 'Catálogo por ticker, com cursor (cópia inicial dos consumidores).',
      auth: 'user',
      query: Type.Object({
        tradable: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])),
        status: Type.Optional(Type.String()),
        limit: Type.Optional(Type.String({ pattern: '^\\d+$' })),
        cursor: Type.Optional(Type.String()),
      }),
      responses: {
        200: {
          description: 'Página.',
          body: Type.Object({
            items: Type.Array(Instrument),
            nextCursor: Type.Optional(Type.String()),
          }),
        },
      },
    },
    universe: {
      method: 'get',
      path: '/v1/instruments/universe',
      summary: 'Universo negociável: "x de max" e os instrumentos (RN-INS-011).',
      auth: 'user',
      responses: {
        200: {
          description: 'Universo.',
          body: Type.Object({
            max: Type.Integer(),
            count: Type.Integer(),
            items: Type.Array(Instrument),
          }),
        },
      },
    },
    getInstrument: {
      method: 'get',
      path: '/v1/instruments/:id',
      summary: 'Detalhe do instrumento.',
      auth: 'user',
      params: IdParams,
      responses: {
        200: { description: 'Instrumento.', body: Instrument },
        404: { description: 'Inexistente.' },
      },
    },
    symbolHistory: {
      method: 'get',
      path: '/v1/instruments/:id/symbol-history',
      summary: 'Tickers antigos com vigência (RN-INS-030).',
      auth: 'user',
      params: IdParams,
      responses: { 200: { description: 'Histórico.' } },
    },
    effectiveRules: {
      method: 'get',
      path: '/v1/trading-rules/effective',
      summary: 'Regras vigentes no instante: global + sobrescrita do instrumento (Ativos §7).',
      auth: 'user',
      query: Type.Object({
        instrumentId: Type.Optional(Uuid),
        at: Type.Optional(Type.String({ format: 'date-time' })),
      }),
      responses: {
        200: {
          description: 'Regras vigentes.',
          body: Type.Object({
            instrumentId: Type.Union([Uuid, Type.Null()]),
            at: Type.String({ format: 'date-time' }),
            values: TradingRulesValues,
            globalRuleId: Type.Union([Uuid, Type.Null()]),
            overrideRuleId: Type.Union([Uuid, Type.Null()]),
            overridden: Type.Array(Type.String()),
          }),
        },
      },
    },
    // ------------------------------------------------------------ calendário (RN-CAL-002)
    calendar: {
      method: 'get',
      path: '/v1/calendar',
      summary: 'Calendário completo (dados do @broker/calendar) para a cópia local (D15).',
      auth: 'user',
      responses: { 200: { description: 'Calendário.', body: CalendarDataSchema } },
    },
    calendarDay: {
      method: 'get',
      path: '/v1/calendar/days/:date',
      summary: 'is_business_day, tipo do dia, D+1/D-1 e session_schedule da data.',
      auth: 'user',
      params: Type.Object({ date: Date_ }),
      responses: {
        200: { description: 'Dia.' },
        422: { description: 'CALENDAR_NOT_LOADED.' },
      },
    },
    nextBusinessDay: {
      method: 'get',
      path: '/v1/calendar/days/:date/next',
      summary: 'next_business_day(d, n) / previous com n negativo.',
      auth: 'user',
      params: Type.Object({ date: Date_ }),
      query: Type.Object({ n: Type.Optional(Type.String({ pattern: '^-?\\d+$' })) }),
      responses: { 200: { description: 'Data.' } },
    },
    businessDaysBetween: {
      method: 'get',
      path: '/v1/calendar/business-days-between',
      summary: 'business_days_between(a, b): dias úteis em (a, b].',
      auth: 'user',
      query: Type.Object({ from: Date_, to: Date_ }),
      responses: { 200: { description: 'Contagem.' } },
    },
    // ------------------------------------------------------------ backoffice
    createInstrument: {
      method: 'post',
      path: '/v1/bo/instruments',
      summary: 'Cadastro manual com o padrão do tipo e sobrescritas (BO_MARKET, sem aprovação).',
      auth: 'user',
      idempotent: true,
      body: Type.Object({
        symbol: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9]{3,5}\\d{1,2}$' }),
        assetType: AssetType,
        shareClass: Type.Optional(ShareClass),
        attributes: Type.Optional(Attributes),
      }),
      responses: { 201: { description: 'Criado (PENDING, fora do universo).', body: Instrument } },
    },
    updateInstrument: {
      method: 'patch',
      path: '/v1/bo/instruments/:id',
      summary: 'Edita atributos (lote, tick, flags, haircut, nomes); o fracionário é derivado.',
      auth: 'user',
      params: IdParams,
      body: Attributes,
      responses: { 200: { description: 'Atualizado.', body: Instrument } },
    },
    setStatus: {
      method: 'post',
      path: '/v1/bo/instruments/:id/status',
      summary: 'Suspender, retomar ou deslistar (BO_MARKET, sem aprovação).',
      auth: 'user',
      params: IdParams,
      body: Type.Object({
        status: Type.Union([
          Type.Literal('SUSPENDED'),
          Type.Literal('ACTIVE'),
          Type.Literal('DELISTED'),
        ]),
        reason: Type.String({ minLength: 3, maxLength: 200 }),
      }),
      responses: { 200: { description: 'Novo status.', body: Instrument } },
    },
    renameInstrument: {
      method: 'post',
      path: '/v1/bo/instruments/:id/rename',
      summary: 'Renomeia mantendo o instrument_id (RN-INS-030).',
      auth: 'user',
      params: IdParams,
      body: Type.Object({
        newSymbol: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9]{3,5}\\d{1,2}$' }),
        effectiveDate: Date_,
      }),
      responses: { 200: { description: 'Renomeado.', body: Instrument } },
    },
    typeDefaults: {
      method: 'get',
      path: '/v1/bo/instrument-type-defaults',
      summary: 'Padrões de cadastro por tipo (Ativos §2.2).',
      auth: 'user',
      responses: {
        200: { description: 'Padrões.', body: Type.Object({ items: Type.Array(TypeDefaults) }) },
      },
    },
    updateTypeDefaults: {
      method: 'put',
      path: '/v1/bo/instrument-type-defaults/:assetType',
      summary: 'Altera o padrão do tipo para os próximos cadastros.',
      auth: 'user',
      params: Type.Object({ assetType: AssetType }),
      body: Type.Partial(Type.Omit(TypeDefaults, ['assetType']), { additionalProperties: false }),
      responses: { 200: { description: 'Padrão.', body: TypeDefaults } },
    },
    requestUniverseChange: {
      method: 'post',
      path: '/v1/bo/universe/requests',
      summary:
        'Propõe incluir/retirar do universo (BO_MARKET → BO_ADMIN). Recusa no limite ou com ordens abertas.',
      auth: 'user',
      idempotent: true,
      body: Type.Object({
        instrumentId: Uuid,
        action: Type.Union([Type.Literal('INCLUDE'), Type.Literal('REMOVE')]),
        justification: Justification,
      }),
      responses: {
        ...Requested,
        422: {
          description:
            'TRADABLE_UNIVERSE_FULL, INSTRUMENT_HAS_OPEN_ORDERS, ALREADY_TRADABLE, NOT_TRADABLE.',
        },
      },
    },
    requestTradingRules: {
      method: 'post',
      path: '/v1/bo/trading-rules/requests',
      summary: 'Propõe nova vigência de regras, global (instrumentId null) ou por instrumento.',
      auth: 'user',
      idempotent: true,
      body: Type.Object({
        instrumentId: Type.Union([Uuid, Type.Null()]),
        rules: Type.Partial(TradingRulesValues),
        validFrom: Type.String({ format: 'date-time' }),
        justification: Justification,
      }),
      responses: {
        ...Requested,
        422: { description: 'INVALID_TRADING_RULES, VALID_FROM_IN_PAST, RULES_VALIDITY_OVERLAP.' },
      },
    },
    tradingRuleVersions: {
      method: 'get',
      path: '/v1/bo/trading-rules',
      summary: 'Vigências do escopo (global sem instrumentId).',
      auth: 'user',
      query: Type.Object({ instrumentId: Type.Optional(Uuid) }),
      responses: { 200: { description: 'Vigências.' } },
    },
    requestCalendarChange: {
      method: 'post',
      path: '/v1/bo/calendar/requests',
      summary: 'Propõe dias especiais e/ou a extensão do período carregado (RN-CAL-001).',
      auth: 'user',
      idempotent: true,
      body: Type.Object({
        extendTo: Type.Optional(Date_),
        days: Type.Optional(
          Type.Array(
            Type.Object({
              date: Date_,
              type: Type.Union(
                ['BUSINESS_DAY', 'HOLIDAY', 'NO_TRADING', 'LATE_OPEN'].map((t) => Type.Literal(t)),
              ),
              description: Type.Optional(Type.String({ maxLength: 200 })),
            }),
            { maxItems: 400 },
          ),
        ),
        justification: Justification,
      }),
      responses: Requested,
    },
    requestSessionSchedule: {
      method: 'post',
      path: '/v1/bo/session-schedules/requests',
      summary: 'Propõe nova grade horária com vigência (RN-CAL-003).',
      auth: 'user',
      idempotent: true,
      body: Type.Object({
        name: Type.String({ minLength: 3, maxLength: 120 }),
        dayType: Type.Union([Type.Literal('BUSINESS_DAY'), Type.Literal('LATE_OPEN')]),
        validFrom: Date_,
        phases: Type.Array(Phase, { minItems: 6, maxItems: 6 }),
        justification: Justification,
      }),
      responses: Requested,
    },
    sessionSchedules: {
      method: 'get',
      path: '/v1/bo/session-schedules',
      summary: 'Grades horárias por vigência.',
      auth: 'user',
      responses: { 200: { description: 'Grades.' } },
    },
    listChangeRequests: {
      method: 'get',
      path: '/v1/bo/change-requests',
      summary: 'Solicitações de aprovação do serviço.',
      auth: 'user',
      query: Type.Object({ status: Type.Optional(Type.String()) }),
      responses: {
        200: {
          description: 'Solicitações.',
          body: Type.Object({ items: Type.Array(ChangeRequest) }),
        },
      },
    },
    approveChangeRequest: {
      method: 'post',
      path: '/v1/bo/change-requests/:id/approve',
      summary: 'Aprova e executa (checker ≠ maker); estado mudado → STALE (RN-MC-BO-003).',
      auth: 'user',
      params: IdParams,
      responses: {
        200: { description: 'APPROVED (executada).', body: ChangeRequest },
        422: {
          description:
            'REQUEST_STALE, MAKER_CANNOT_APPROVE, CHECKER_ROLE_REQUIRED, REQUEST_EXPIRED.',
        },
      },
    },
    rejectChangeRequest: {
      method: 'post',
      path: '/v1/bo/change-requests/:id/reject',
      summary: 'Reprova a solicitação.',
      auth: 'user',
      params: IdParams,
      body: Type.Object({ reason: Type.String({ minLength: 3, maxLength: 500 }) }),
      responses: { 200: { description: 'REJECTED.', body: ChangeRequest } },
    },
    cancelChangeRequest: {
      method: 'post',
      path: '/v1/bo/change-requests/:id/cancel',
      summary: 'O maker cancela a própria solicitação pendente.',
      auth: 'user',
      params: IdParams,
      responses: { 200: { description: 'CANCELED.', body: ChangeRequest } },
    },
    listTasks: {
      method: 'get',
      path: '/v1/bo/tasks',
      summary: 'Tarefas do backoffice: renomeações a confirmar, calendário acabando, catálogo.',
      auth: 'user',
      query: Type.Object({ status: Type.Optional(Type.String()) }),
      responses: {
        200: { description: 'Tarefas.', body: Type.Object({ items: Type.Array(Task) }) },
      },
    },
    confirmTask: {
      method: 'post',
      path: '/v1/bo/tasks/:id/confirm',
      summary: 'Confirma a renomeação da tarefa (RN-INS-033).',
      auth: 'user',
      params: IdParams,
      responses: {
        200: { description: 'Renomeado.' },
        422: { description: 'CONVERSION_IS_CORPORATE_ACTION.' },
      },
    },
    resolveTask: {
      method: 'post',
      path: '/v1/bo/tasks/:id/resolve',
      summary: 'Conclui ou descarta a tarefa.',
      auth: 'user',
      params: IdParams,
      body: Type.Object({ status: Type.Union([Type.Literal('DONE'), Type.Literal('DISMISSED')]) }),
      responses: { 200: { description: 'Tarefa.', body: Task } },
    },
  },
});

export default referenceDataServiceHttp;
