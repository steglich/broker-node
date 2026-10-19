import pg from 'pg';
import type { DatabaseConfig } from './config.js';

export interface LeaderElectorOptions {
  /** Banco do próprio serviço (D14: sem componente extra de coordenação). */
  database: DatabaseConfig;
  /** Nome do papel disputado, ex.: `scheduler`, `brapi-queue`, `risk-partition-3`. */
  name: string;
  /** Intervalo do heartbeat e das tentativas de assumir (padrão 2 s). */
  heartbeatMs?: number;
  /** Tempo máximo de uma consulta do heartbeat; se passar, a liderança é dada como perdida. */
  heartbeatTimeoutMs?: number;
  onElected?: () => void;
  onRevoked?: (reason: string) => void;
  onError?: (err: unknown) => void;
}

/**
 * Eleição de líder por advisory lock de sessão do PostgreSQL (RN-ENV-021, D14).
 *
 * - Cada candidato mantém uma conexão própria e tenta `pg_try_advisory_lock(chave)` a cada
 *   heartbeat. Quem consegue é o líder; os demais ficam em espera (*standby*).
 * - O lock é da sessão: se o processo do líder morre, a conexão cai, o PostgreSQL solta o lock
 *   e o próximo candidato assume na tentativa seguinte.
 * - O líder confirma a liderança a cada heartbeat consultando `pg_locks` pela própria sessão. Se a
 *   consulta falha ou demora mais que o limite, ele se declara não-líder (`onRevoked`) antes que
 *   outro possa assumir, e reconecta para voltar a disputar.
 *
 * Limite conhecido: entre a perda real da conexão e o próximo heartbeat, o antigo líder ainda
 * pode achar que lidera. Quem escreve sob liderança deve gravar no mesmo banco, onde a perda da
 * sessão também derruba a transação, ou usar um token de cerca (*fencing token*).
 */
export class LeaderElector {
  private client: pg.Client | undefined;
  private timer: NodeJS.Timeout | undefined;
  private leader = false;
  private stopped = true;
  private ticking = false;
  private readonly heartbeatMs: number;
  private readonly heartbeatTimeoutMs: number;

  constructor(private readonly options: LeaderElectorOptions) {
    this.heartbeatMs = options.heartbeatMs ?? 2000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? Math.max(1000, this.heartbeatMs);
  }

  isLeader(): boolean {
    return this.leader;
  }

  /** Começa a disputar. Resolve depois da primeira tentativa (já líder ou em espera). */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.heartbeatMs);
  }

  /** Para de disputar e solta a liderança (encerra a conexão, o que libera o lock). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.dropConnection('parado');
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const client = await this.connection();
      if (this.leader) {
        const held = await this.withTimeout(
          client.query<{ held: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_locks
               WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()
                 AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)
             ) AS held`,
            [this.options.name],
          ),
        );
        if (!held.rows[0]?.held) await this.dropConnection('lock perdido');
      } else {
        const res = await this.withTimeout(
          client.query<{ acquired: boolean }>(
            'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
            [this.options.name],
          ),
        );
        if (res.rows[0]?.acquired && !this.stopped) {
          this.leader = true;
          this.options.onElected?.();
        }
      }
    } catch (err) {
      this.options.onError?.(err);
      await this.dropConnection(
        `falha no heartbeat: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  private async connection(): Promise<pg.Client> {
    if (this.client) return this.client;
    const { database } = this.options;
    const client = new pg.Client({
      host: database.host,
      port: database.port,
      database: database.database,
      user: database.user,
      password: database.password,
      application_name: `leader:${this.options.name}`,
    });
    // Erro assíncrono na conexão (ex.: servidor encerrou a sessão): perde a liderança na hora.
    client.on('error', (err) => {
      this.options.onError?.(err);
      void this.dropConnection(`conexão perdida: ${err.message}`);
    });
    await client.connect();
    this.client = client;
    return client;
  }

  private async dropConnection(reason: string): Promise<void> {
    const wasLeader = this.leader;
    this.leader = false;
    const client = this.client;
    this.client = undefined;
    if (wasLeader) this.options.onRevoked?.(reason);
    if (client) await client.end().catch(() => undefined);
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`heartbeat passou de ${this.heartbeatTimeoutMs} ms`)),
        this.heartbeatTimeoutMs,
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}
