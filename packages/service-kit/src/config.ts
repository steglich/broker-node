import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import Type, { type Static, type TObject } from 'typebox';

/**
 * Versão do serviço que está rodando: a do `package.json` do diretório atual (`/app` na imagem,
 * onde o `pnpm deploy` deixa o manifesto; a pasta do serviço em desenvolvimento). Ela é a fonte da
 * verdade do semver por serviço (RN-CICD-020), mantida pelo `pnpm release`.
 */
export function packageVersion(dir = process.cwd()): string {
  try {
    const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Configuração comum a todo serviço. Cada serviço estende com `Type.Composite`/spread das
 * propriedades e valida tudo de uma vez ao iniciar (RN-BE-061, RN-PAD-070).
 */
export const BaseConfigProperties = {
  SERVICE_NAME: Type.String({ minLength: 1, pattern: '^[a-z][a-z0-9-]*$' }),
  /** Padrão: a versão do `package.json` (RN-CICD-020). A variável sobrescreve. */
  SERVICE_VERSION: Type.String({ default: packageVersion() }),
  /** Commit do build: a imagem traz em `GIT_COMMIT` (build arg do Dockerfile). */
  GIT_COMMIT: Type.String({ default: 'unknown' }),
  ENVIRONMENT: Type.String({ minLength: 1, pattern: '^[a-z][a-z0-9-]*$' }),
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 8080 }),
  LOG_LEVEL: Type.Union(
    ['fatal', 'error', 'warn', 'info', 'debug', 'trace'].map((l) => Type.Literal(l)),
    { default: 'info' },
  ),
  SHUTDOWN_TIMEOUT_MS: Type.Integer({ minimum: 0, default: 10_000 }),
};
export const BaseConfig = Type.Object(BaseConfigProperties);
export type BaseConfig = Static<typeof BaseConfig>;

/** Configuração inválida: a mensagem lista as variáveis com problema, nunca os valores. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(readonly problems: string[]) {
    super(`configuração inválida:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false, coerceTypes: true, useDefaults: true });
addFormats.default(ajv);

/**
 * Lê e valida a configuração do ambiente. Para cada variável `X`, se existir `X_FILE`, o valor vem
 * do arquivo (Docker secret em `/run/secrets/...`, D18): segredos não precisam passar por variável
 * de ambiente. Números e booleanos são convertidos; valores padrão são aplicados.
 */
export function loadConfig<S extends TObject>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): Static<S> {
  const raw: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const key of Object.keys(schema.properties)) {
    const file = env[`${key}_FILE`];
    if (file) {
      try {
        raw[key] = readFileSync(file, 'utf8').trim();
      } catch {
        problems.push(`${key}: não foi possível ler o arquivo indicado em ${key}_FILE`);
      }
    } else if (env[key] !== undefined && env[key] !== '') {
      raw[key] = env[key];
    }
  }
  const validate = ajv.compile(schema as object);
  if (!validate(raw)) {
    for (const e of validate.errors ?? []) {
      if (e.keyword === 'required') {
        const name = (e.params as { missingProperty: string }).missingProperty;
        problems.push(`${name}: obrigatória e ausente (defina ${name} ou ${name}_FILE)`);
      } else {
        // Só o nome e a regra: o valor pode ser um segredo e nunca aparece na mensagem.
        problems.push(`${e.instancePath.replace(/^\//, '')}: ${e.message ?? 'inválida'}`);
      }
    }
  }
  if (problems.length > 0) throw new ConfigError([...new Set(problems)]);
  return raw as Static<S>;
}

/**
 * Falha rápido (RN-BE-061): com configuração inválida, imprime o problema e encerra com código 1,
 * antes de abrir conexões ou portas.
 */
export function loadConfigOrExit<S extends TObject>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
): Static<S> {
  try {
    return loadConfig(schema, env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const service = env['SERVICE_NAME'] ?? 'serviço';
    process.stderr.write(`[${service}] ${err.message}\n`);
    process.exit(1);
  }
}
