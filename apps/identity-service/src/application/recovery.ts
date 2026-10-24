import { SIGNATURE_RECOVERY_BLOCK_MS, type Realm } from '../domain/policies.js';
import type { Accounts } from './accounts.js';
import type { Auth } from './auth.js';
import { CTX, IdentityError, normalizeEmail, requireUser, type IdentityDeps } from './context.js';
import { invalidMfa, type Factors } from './factors.js';
import type { IdentityTx, OneTimeTokenRow } from './ports.js';

const RECOVERY_TTL_MS = 15 * 60_000;
const SMS_OTP_ATTEMPTS = 5;

const invalidLink = () =>
  new IdentityError(400, 'INVALID_LINK', 'Link inválido ou expirado. Peça outro.');

/**
 * Recuperação de acesso (RN-AUTH-004): link de uso único por e-mail (15 min) mais segundo fator
 * (TOTP ou OTP por SMS). Depois da troca, todas as sessões caem e a assinatura fica bloqueada por
 * 24 h, contra tomada de conta. Também conclui o convite do backoffice (senha + TOTP).
 */
export class Recovery {
  constructor(
    private readonly d: IdentityDeps,
    private readonly auth: Auth,
    private readonly factors: Factors,
    private readonly accounts: Accounts,
  ) {}

  /** Sempre `202`: a resposta não revela se o e-mail existe. */
  async request(realm: Realm, rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const now = this.d.clock.now();
    const token = this.d.random.token();
    const sent = await this.d.store.transaction(async (tx) => {
      const user = await tx.userByEmail(realm, this.d.fields.emailHash(email));
      if (!user || user.status !== 'ACTIVE') return false;
      await tx.insertOneTimeToken({
        tokenHash: this.d.random.sha256(token),
        purpose: 'RECOVERY',
        userId: user.id,
        otpHash: null,
        otpAttempts: 0,
        expiresAt: now.plusMillis(RECOVERY_TTL_MS),
        usedAt: null,
      });
      return true;
    });
    if (!sent) return;
    await this.d.messenger.email(
      email,
      'Recuperação de acesso',
      `Use o link abaixo em até 15 minutos para criar uma senha nova. Ele só funciona uma vez.\n\n` +
        `${this.d.links.recovery}?token=${token}\n\nSe não foi você, ignore este e-mail.`,
    );
  }

  /** Quais segundos fatores servem para concluir a recuperação. */
  async methods(token: string): Promise<{ methods: ('TOTP' | 'SMS')[] }> {
    return this.d.store.transaction(async (tx) => {
      const t = await this.live(tx, token, 'RECOVERY');
      const types = new Set((await tx.factors(t.userId)).map((f) => f.type));
      return { methods: (['TOTP', 'SMS'] as const).filter((m) => types.has(m)) };
    });
  }

  /** Envia o OTP por SMS (fator fraco, só para recuperação, RN-AUTH-003). */
  async sendSmsOtp(token: string): Promise<void> {
    const code = this.d.random.digits(6);
    const phone = await this.d.store.transaction(async (tx) => {
      const t = await this.live(tx, token, 'RECOVERY', true);
      const sms = (await tx.factors(t.userId)).find((f) => f.type === 'SMS');
      if (!sms)
        throw new IdentityError(422, 'NO_SMS_FACTOR', 'Nenhum telefone de recuperação cadastrado.');
      await tx.updateOneTimeToken(t.tokenHash, {
        otpHash: this.d.random.sha256(code),
        otpAttempts: 0,
      });
      return this.d.fields.open(sms.phoneEnc!, CTX.phone);
    });
    await this.d.messenger.sms(phone, `Código de recuperação de acesso: ${code}. Não compartilhe.`);
  }

  async complete(input: {
    token: string;
    newPassword: string;
    proof: { method: 'TOTP' | 'SMS'; code: string };
  }): Promise<void> {
    const now = this.d.clock.now();
    const result = await this.d.store.transaction(async (tx) => {
      const t = await this.live(tx, input.token, 'RECOVERY', true);
      const user = await requireUser(tx, t.userId);
      const factorTypes = new Set((await tx.factors(user.id)).map((f) => f.type));
      if (!factorTypes.has('TOTP') && !factorTypes.has('SMS')) {
        throw new IdentityError(
          422,
          'RECOVERY_SECOND_FACTOR_UNAVAILABLE',
          'Sem segundo fator cadastrado: procure o atendimento.',
        );
      }
      if (input.proof.method === 'SMS') {
        if (!t.otpHash || t.otpAttempts >= SMS_OTP_ATTEMPTS) throw invalidMfa();
        if (t.otpHash !== this.d.random.sha256(input.proof.code)) {
          await tx.updateOneTimeToken(t.tokenHash, { otpAttempts: t.otpAttempts + 1 });
          return { error: invalidMfa() };
        }
      } else {
        await this.factors.verify(tx, user.id, { method: 'TOTP', code: input.proof.code });
      }
      this.accounts.assertPassword(input.newPassword, this.accounts.profile(user));
      await tx.setPassword(user.id, await this.d.hasher.hash(input.newPassword), now);
      await tx.updateOneTimeToken(t.tokenHash, { usedAt: now });
      await tx.saveThrottle(user.realm, user.emailHash, {
        failures: 0,
        lastFailureAt: null,
        lockedUntil: null,
      });
      await this.auth.revokeAll(tx, user.id, 'PASSWORD_RECOVERY', now);
      const sig = await tx.signature(user.id);
      if (sig)
        await tx.saveSignature({
          ...sig,
          blockedUntil: now.plusMillis(SIGNATURE_RECOVERY_BLOCK_MS),
        });
      await tx.publish(
        { type: 'identity.password_changed', payload: { userId: user.id, at: now.toString() } },
        user.id,
      );
      return { ok: true as const };
    });
    if ('error' in result) throw result.error;
  }

  // ---------------------------------------------------------------- convite do backoffice

  /** Primeira etapa do convite: o segredo do TOTP a cadastrar no autenticador. */
  async invitationStart(token: string): Promise<{ secret: string; uri: string }> {
    return this.d.store.transaction(async (tx) => {
      const t = await this.live(tx, token, 'INVITATION', true);
      const user = await requireUser(tx, t.userId);
      const label = this.d.fields.open(user.emailEnc, CTX.email);
      const { secret, uri } = await this.factors.totpStart(tx, user.id, label);
      return { secret, uri };
    });
  }

  /** Conclui: senha pela política + código TOTP válido. Só então a conta fica ativa (RN-BO-002). */
  async invitationComplete(input: {
    token: string;
    password: string;
    totpCode: string;
  }): Promise<void> {
    const now = this.d.clock.now();
    await this.d.store.transaction(async (tx) => {
      const t = await this.live(tx, input.token, 'INVITATION', true);
      const user = await requireUser(tx, t.userId);
      this.accounts.assertPassword(input.password, this.accounts.profile(user));
      await this.factors.totpConfirm(tx, user.id, input.totpCode);
      await tx.setPassword(user.id, await this.d.hasher.hash(input.password), now);
      await tx.updateUser(user.id, { status: 'ACTIVE' });
      await tx.updateOneTimeToken(t.tokenHash, { usedAt: now });
    });
  }

  private async live(
    tx: IdentityTx,
    token: string,
    purpose: OneTimeTokenRow['purpose'],
    forUpdate = false,
  ): Promise<OneTimeTokenRow> {
    const t = await tx.oneTimeToken(this.d.random.sha256(token), { forUpdate });
    if (!t || t.purpose !== purpose || t.usedAt || !this.d.clock.now().isBefore(t.expiresAt))
      throw invalidLink();
    return t;
  }
}
