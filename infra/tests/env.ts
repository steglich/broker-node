import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const secretsDir = fileURLToPath(new URL('../secrets/', import.meta.url));

/** Lê um segredo gerado em infra/secrets/ (o mesmo arquivo que vira Docker secret). */
export const secret = (name: string): string => readFileSync(secretsDir + name, 'utf8').trim();

export const hosts = {
  postgresPort: Number(process.env['POSTGRES_PORT'] ?? 5432),
  minioPort: Number(process.env['MINIO_PORT'] ?? 9000),
  httpPort: Number(process.env['HTTP_PORT'] ?? 80),
  httpsPort: Number(process.env['HTTPS_PORT'] ?? 443),
};
