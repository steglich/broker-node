import { applyFill, EMPTY_POSITION, type Position } from '../domain/position.js';
import type { Fill } from './ports.js';

/** Refaz a posição a partir das pontas vivas: o custo médio depende da ordem dos negócios. */
export function resolveFills(fills: readonly Fill[]): Position {
  return fills.reduce((p, f) => applyFill(p, f.side, f.quantity, f.price), EMPTY_POSITION);
}
