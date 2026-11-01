import Type from 'typebox';
import { Board } from './session.js';

/** Campos de toda saída do Motor (Catálogo de eventos §7). */
export const BookOutput = {
  instrumentId: Type.String({ format: 'uuid' }),
  board: Board,
  /** Contínuo por livro (RN-ME-004): os consumidores deduplicam e detectam lacunas por ele. */
  engineSeq: Type.Integer({ minimum: 1 }),
  inputSeq: Type.Integer({ minimum: 1 }),
};
