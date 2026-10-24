import type { Valkey } from 'iovalkey';

/**
 * Lista de revogação no Valkey (D9, RN-AUTH-013/014). O identity-service grava; o gateway e os
 * serviços leem. Cada entrada vive só até o token mais longo que ela derruba expirar: depois disso,
 * o próprio `exp` do token já o recusa.
 */
export class RevocationList {
  constructor(
    private readonly valkey: Valkey,
    private readonly prefix = 'revoked',
  ) {}

  async revokeSession(sessionId: string, ttlMs: number): Promise<void> {
    await this.valkey.set(
      `${this.prefix}:session:${sessionId}`,
      '1',
      'PX',
      Math.max(1, Math.ceil(ttlMs)),
    );
  }

  async revokeSignature(jti: string, ttlMs: number): Promise<void> {
    await this.valkey.set(
      `${this.prefix}:signature:${jti}`,
      '1',
      'PX',
      Math.max(1, Math.ceil(ttlMs)),
    );
  }

  async isSessionRevoked(sessionId: string): Promise<boolean> {
    return (await this.valkey.exists(`${this.prefix}:session:${sessionId}`)) === 1;
  }

  async isSignatureRevoked(jti: string): Promise<boolean> {
    return (await this.valkey.exists(`${this.prefix}:signature:${jti}`)) === 1;
  }
}
