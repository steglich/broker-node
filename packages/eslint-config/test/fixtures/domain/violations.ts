// Arquivo de verificação: cada linha abaixo DEVE ser rejeitada pelo lint.
import { db } from '../adapters/db.js';

export const now = Date.now();
export const today = new Date();
export const noise = Math.random();
export const ok = new Date('2026-01-02T00:00:00Z');
import 'pg';
export { db };
