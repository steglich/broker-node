import { baseMigrations } from '@broker/persistence';
import type { Migration } from 'kysely/migration';

/** Só a plataforma: a outbox dos eventos `audit.*` (o BFF não guarda estado de negócio). */
export const migrations: Record<string, Migration> = { ...baseMigrations };
