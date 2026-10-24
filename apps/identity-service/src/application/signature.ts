import {
  hasRecentMfa,
  isSignatureSecret,
  registerSignatureFailure,
  signatureAvailability,
  signatureTokenTtlMs,
  type SignatureScope,
} from '../domain/policies.js';
import { activeSession, IdentityError, type Caller, type IdentityDeps } from './context.js';
import { stepUpRequired } from './factors.js';
import type { SignatureRow } from './ports.js';

const REFUSAL_MESSAGES = {
  SIGNATURE_LOCKED: 'Assinatura bloqueada por 30 minutos depois de 3 erros.',
  SIGNATURE_RESET_REQUIRED: 'Assinatura bloqueada: redefina com o segundo fator.',
  SIGNATURE_BLOCKED: 'Assinatura bloqueada por 24 horas depois da recuperação de acesso.',
} as const;

/** Assinatura eletrônica (RN-SIG-001..004): segredo próprio e token curto por escopo. */
export class TradingSignature {
  constructor(private readonly d: IdentityDeps) {}

  /**
   * Cadastra ou redefine o segredo (6 a 8 dígitos, hash próprio). Nunca coincide com a senha de
   * login, que tem no mínimo 10 caracteres (RN-SIG-001). Redefinir, inclusive depois do
   * bloqueio de 6 erros, exige MFA nos últimos 15 min. O bloqueio da recuperação continua valendo.
   */
  async set(caller: Caller, secret: string): Promise<void> {
    if (!isSignatureSecret(secret))
      throw new IdentityError(400, 'INVALID_SIGNATURE_FORMAT', 'Use de 6 a 8 dígitos.', 'secret');
    const secretHash = await this.d.hasher.hash(secret);
    await this.d.store.transaction(async (tx) => {
      const now = this.d.clock.now();
      const session = await activeSession(tx, caller, now);
      const current = await tx.signature(caller.userId);
      if (current && !hasRecentMfa(session.mfaAt, now)) throw stepUpRequired();
      await tx.saveSignature({
        userId: caller.userId,
        secretHash,
        failures: 0,
        lockedUntil: null,
        resetRequired: false,
        blockedUntil: current?.blockedUntil ?? null,
        changedAt: now,
      });
      await tx.publish(
        {
          type: 'identity.trading_signature_changed',
          payload: { userId: caller.userId, at: now.toString() },
        },
        caller.userId,
      );
    });
  }

  /**
   * Valida o segredo e emite o token de assinatura (RN-SIG-003): vinculado à sessão e ao escopo,
   * 5 min (ou até 8 h com "lembrar nesta sessão", só para ordens). 3 erros bloqueiam 30 min; 6,
   * até redefinir com MFA (RN-SIG-004).
   */
  async verify(
    caller: Caller,
    input: { secret: string; scope: SignatureScope; rememberInSession?: boolean },
  ): Promise<{ signatureToken: string; scope: SignatureScope; expiresAt: string }> {
    const now = this.d.clock.now();
    const result = await this.d.store.transaction(async (tx) => {
      const session = await activeSession(tx, caller, now);
      const sig = await tx.signature(caller.userId);
      if (!sig)
        throw new IdentityError(422, 'SIGNATURE_NOT_SET', 'Cadastre a assinatura eletrônica.');
      const refusal = signatureAvailability(sig, now);
      if (refusal) {
        throw new IdentityError(
          423,
          refusal.refusal,
          REFUSAL_MESSAGES[refusal.refusal],
          undefined,
          refusal.until ?? undefined,
        );
      }
      if (!(await this.d.hasher.verify(sig.secretHash, input.secret))) {
        const next: SignatureRow = { ...sig, ...registerSignatureFailure(sig, now) };
        await tx.saveSignature(next);
        return {
          error: new IdentityError(401, 'INVALID_SIGNATURE', 'Assinatura eletrônica incorreta.'),
        };
      }
      await tx.saveSignature({ ...sig, failures: 0, lockedUntil: null });
      const ttl = signatureTokenTtlMs(
        input.scope,
        input.rememberInSession ?? false,
        session.expiresAt.epochMillis - now.epochMillis,
      );
      const jti = this.d.newId();
      const expiresAt = now.plusMillis(ttl);
      await tx.insertSignatureToken({
        jti,
        userId: caller.userId,
        sessionId: session.id,
        scope: input.scope,
        expiresAt,
      });
      const signatureToken = await this.d.signer.signatureToken(
        { sub: caller.userId, session_id: session.id, sig_scope: input.scope, jti },
        now,
        ttl,
      );
      return { signatureToken, scope: input.scope, expiresAt: expiresAt.toString() };
    });
    // O erro sai depois do commit: o contador de erros precisa ficar gravado.
    if ('error' in result) throw result.error;
    return result;
  }
}
