// One-shot de migração: roda com <svc>_migrator e termina. O serviço só sobe depois dele.
import { runMigrationsFromEnv } from '@broker/persistence';
import { migrations } from './migrations.js';

process.exitCode = await runMigrationsFromEnv(migrations);
