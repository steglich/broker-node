import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Tokens da brapi (RN-BRP-090/094): vêm do cofre (Docker secrets em `/run/secrets/*`), nunca da
 * imagem, do repositório, de log, de erro ou de evento. Dois tokens convivem na rotação: o atual e
 * o próximo. Os arquivos são relidos a cada uso, então trocar o segredo não exige reinício.
 */
export interface TokenSource {
  /** Em ordem de preferência; vazio = sem token (só endpoints e tickers que dispensam). */
  tokens(): Promise<string[]>;
  /** Promove o token que funcionou (o novo entra; o antigo sai depois da confirmação). */
  confirm(token: string): void;
}

/** Impressão digital para logs e travas: nunca o token em si. */
export const fingerprint = (token: string) =>
  createHash('sha256').update(token).digest('hex').slice(0, 12);

export class FileTokenSource implements TokenSource {
  private preferred: string | null = null;

  constructor(private readonly files: readonly string[]) {}

  async tokens(): Promise<string[]> {
    const values: string[] = [];
    for (const f of this.files) {
      const v = (await readFile(f, 'utf8').catch(() => '')).trim();
      if (v && !values.includes(v)) values.push(v);
    }
    if (this.preferred && values.includes(this.preferred))
      return [this.preferred, ...values.filter((v) => v !== this.preferred)];
    return values;
  }

  confirm(token: string): void {
    this.preferred = token;
  }
}

export class StaticTokenSource implements TokenSource {
  private preferred: string | null = null;

  constructor(private readonly values: readonly string[]) {}

  async tokens(): Promise<string[]> {
    const vs = this.values.filter(Boolean);
    if (this.preferred && vs.includes(this.preferred))
      return [this.preferred, ...vs.filter((v) => v !== this.preferred)];
    return [...vs];
  }

  confirm(token: string): void {
    this.preferred = token;
  }
}
