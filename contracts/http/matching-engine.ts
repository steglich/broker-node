// matching-engine (catálogo de serviços §9): sem API de negócio. Entrada só por `engine.commands`;
// esta é a API administrativa (saúde vem do service-kit, snapshot e replay ficam aqui).
import Type from 'typebox';
import { defineHttpContract } from '../src/define.js';
import { SessionPhase } from '../src/schemas/session.js';

const InstrumentParam = Type.Object({ instrumentId: Type.String({ format: 'uuid' }) });

const BookStatus = Type.Object({
  instrumentId: Type.String(),
  partition: Type.Integer({ minimum: 0 }),
  /** Nulo quando a partição está com outra instância. */
  phase: Type.Union([SessionPhase, Type.Null()]),
  inputSeq: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});

export const matchingEngineHttp = defineHttpContract({
  service: 'matching-engine',
  title: 'matching-engine',
  version: '1.0.0',
  routes: {
    books: {
      method: 'get',
      path: '/v1/admin/engine/books',
      summary: 'Livros conhecidos, com a partição e o estado nesta instância.',
      auth: 'user',
      responses: {
        200: { description: 'Lista.', body: Type.Object({ items: Type.Array(BookStatus) }) },
      },
    },
    snapshot: {
      method: 'post',
      path: '/v1/admin/engine/books/:instrumentId/snapshot',
      summary: 'Tira um snapshot agora (RN-REC-001).',
      auth: 'user',
      params: InstrumentParam,
      responses: {
        200: {
          description: 'Snapshot gravado.',
          body: Type.Object({
            instrumentId: Type.String(),
            inputSeq: Type.Integer({ minimum: 0 }),
          }),
        },
        404: { description: 'Livro não está nesta instância.' },
      },
    },
    replay: {
      method: 'post',
      path: '/v1/admin/engine/books/:instrumentId/replay',
      summary:
        'Reprocessa o journal à parte, sem efeito nenhum, e compara com as saídas gravadas (ADR-0005).',
      auth: 'user',
      params: InstrumentParam,
      responses: {
        200: {
          description: 'Resultado da comparação.',
          body: Type.Object({
            instrumentId: Type.String(),
            inputs: Type.Integer({ minimum: 0 }),
            outputs: Type.Integer({ minimum: 0 }),
            identical: Type.Boolean(),
            firstDifference: Type.Union([Type.String(), Type.Null()]),
          }),
        },
      },
    },
  },
});

export default matchingEngineHttp;
