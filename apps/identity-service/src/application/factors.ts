import type { Instant } from '@broker/domain-kernel';
import { hasRecentMfa } from '../domain/policies.js';
import {
  activeSession,
  CTX,
  IdentityError,
  requireUser,
  type Caller,
  type IdentityDeps,
} from './context.js';
import type { FactorRow, IdentityTx } from './ports.js';

const SMS_OTP_TTL_MS = 5 * 60_000;
const E164 = /^\+[1-9]\d{7,14}$/;

/** Prova de segundo fator: código TOTP ou resposta WebAuthn (o desafio vem de quem pediu). */
export type FactorProof =
  { method: 'TOTP'; code: string } | { method: 'WEBAUTHN'; response: unknown };

/** `amr` (RFC 8176) de cada fator: `otp` para TOTP, `hwk` para chave/biometria WebAuthn. */
export const AMR = { TOTP: 'otp', WEBAUTHN: 'hwk', SMS: 'sms' } as const;

export const invalidMfa = () =>
  new IdentityError(401, 'INVALID_MFA', 'Código de verificação inválido.');

/** Fatores de MFA (RN-AUTH-003): TOTP e WebAuthn fortes; OTP por SMS só para recuperação. */
export class Factors {
  constructor(private readonly d: IdentityDeps) {}

  async strong(tx: IdentityTx, userId: string): Promise<FactorRow[]> {
    return (await tx.factors(userId)).filter((f) => f.type !== 'SMS');
  }

  /** Confere uma prova de fator forte; devolve o `amr` do método ou lança `INVALID_MFA`. */
  async verify(
    tx: IdentityTx,
    userId: string,
    proof: FactorProof,
    webauthnChallenge?: string | null,
  ): Promise<string> {
    const now = this.d.clock.now();
    const factors = await this.strong(tx, userId);
    if (proof.method === 'TOTP') {
      for (const f of factors.filter((x) => x.type === 'TOTP')) {
        const secret = this.d.fields.open(f.secretEnc!, CTX.totp);
        const step = this.d.totp.verify(secret, proof.code, now, f.lastUsedStep);
        if (step !== null) {
          // O mesmo código não serve duas vezes (replay dentro dos 30 s).
          await tx.updateFactor(f.id, { lastUsedStep: step });
          return AMR.TOTP;
        }
      }
      throw invalidMfa();
    }
    const credentialId = (proof.response as { id?: unknown } | null)?.id;
    if (!webauthnChallenge || typeof credentialId !== 'string') throw invalidMfa();
    const f = factors.find((x) => x.type === 'WEBAUTHN' && x.credentialId === credentialId);
    if (!f) throw invalidMfa();
    const ok = await this.d.webauthn.verifyAuthentication(proof.response, webauthnChallenge, {
      credentialId: f.credentialId!,
      publicKey: f.publicKey!,
      signCount: f.signCount ?? 0,
    });
    if (!ok) throw invalidMfa();
    await tx.updateFactor(f.id, { signCount: ok.signCount });
    return AMR.WEBAUTHN;
  }

  /** Opções de autenticação WebAuthn com as credenciais ativas do usuário. */
  async webauthnAssertion(
    tx: IdentityTx,
    userId: string,
  ): Promise<{ options: object; challenge: string }> {
    const creds = (await this.strong(tx, userId)).filter((f) => f.type === 'WEBAUTHN');
    if (creds.length === 0)
      throw new IdentityError(422, 'NO_WEBAUTHN_FACTOR', 'Nenhuma chave de segurança cadastrada.');
    return this.d.webauthn.authenticationOptions(
      creds.map((c) => ({ credentialId: c.credentialId!, transports: c.transports ?? [] })),
    );
  }

  // ---------------------------------------------------------------- TOTP

  /** Começa a ativação: segredo novo num fator pendente (o anterior pendente é descartado). */
  async totpStart(
    tx: IdentityTx,
    userId: string,
    label: string,
  ): Promise<{ factorId: string; secret: string; uri: string }> {
    for (const f of await tx.factors(userId, { includePending: true })) {
      if (f.type === 'TOTP' && f.status === 'PENDING')
        await tx.updateFactor(f.id, { status: 'REMOVED' });
    }
    const secret = this.d.totp.newSecret();
    const factor = this.newFactor(userId, 'TOTP', {
      secretEnc: this.d.fields.seal(secret, CTX.totp),
    });
    await tx.insertFactor(factor);
    return { factorId: factor.id, secret, uri: this.d.totp.uri(secret, label) };
  }

  /** Confirma com um código válido: o fator fica ativo e sai `identity.mfa_enabled`. */
  async totpConfirm(tx: IdentityTx, userId: string, code: string): Promise<string> {
    const now = this.d.clock.now();
    const pending = (await tx.factors(userId, { includePending: true })).find(
      (f) => f.type === 'TOTP' && f.status === 'PENDING',
    );
    if (!pending)
      throw new IdentityError(
        409,
        'NO_PENDING_FACTOR',
        'Comece a ativação do autenticador de novo.',
      );
    const step = this.d.totp.verify(
      this.d.fields.open(pending.secretEnc!, CTX.totp),
      code,
      now,
      null,
    );
    if (step === null) throw invalidMfa();
    await tx.updateFactor(pending.id, { status: 'ACTIVE', activatedAt: now, lastUsedStep: step });
    await this.mfaEnabled(tx, userId, now);
    return pending.id;
  }

  async enrollTotp(caller: Caller, label: string) {
    return this.d.store.transaction(async (tx) => {
      await activeSession(tx, caller, this.d.clock.now());
      return this.totpStart(tx, caller.userId, label);
    });
  }

  async confirmTotp(caller: Caller, code: string): Promise<{ factorId: string }> {
    return this.d.store.transaction(async (tx) => {
      const now = this.d.clock.now();
      await activeSession(tx, caller, now);
      const factorId = await this.totpConfirm(tx, caller.userId, code);
      // Quem acabou de provar o fator conta como MFA recente (step-up).
      await tx.recordMfa(caller.sessionId, [AMR.TOTP], now);
      return { factorId };
    });
  }

  // ---------------------------------------------------------------- WebAuthn

  async webauthnRegistrationOptions(
    caller: Caller,
    name: string,
  ): Promise<{ factorId: string; options: object }> {
    return this.d.store.transaction(async (tx) => {
      await activeSession(tx, caller, this.d.clock.now());
      const existing = (await this.strong(tx, caller.userId))
        .filter((f) => f.type === 'WEBAUTHN')
        .map((f) => f.credentialId!);
      const { options, challenge } = await this.d.webauthn.registrationOptions(
        { id: caller.userId, name },
        existing,
      );
      // O desafio fica no fator pendente até a resposta do navegador.
      const factor = this.newFactor(caller.userId, 'WEBAUTHN', { secretEnc: challenge });
      await tx.insertFactor(factor);
      return { factorId: factor.id, options };
    });
  }

  async webauthnRegister(
    caller: Caller,
    factorId: string,
    response: unknown,
  ): Promise<{ factorId: string }> {
    return this.d.store.transaction(async (tx) => {
      const now = this.d.clock.now();
      await activeSession(tx, caller, now);
      const f = await tx.factorById(factorId);
      if (!f || f.userId !== caller.userId || f.type !== 'WEBAUTHN' || f.status !== 'PENDING')
        throw new IdentityError(404, 'NOT_FOUND', 'Cadastro de chave inexistente.');
      const verified = await this.d.webauthn.verifyRegistration(response, f.secretEnc!);
      if (!verified) throw invalidMfa();
      await tx.updateFactor(f.id, {
        status: 'ACTIVE',
        activatedAt: now,
        secretEnc: null,
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        signCount: verified.signCount,
        transports: verified.transports,
      });
      await this.mfaEnabled(tx, caller.userId, now);
      await tx.recordMfa(caller.sessionId, [AMR.WEBAUTHN], now);
      return { factorId: f.id };
    });
  }

  // ---------------------------------------------------------------- SMS (só recuperação)

  /** Cadastra o telefone de recuperação: envia um OTP e espera a confirmação. */
  async enrollSms(caller: Caller, phone: string): Promise<{ factorId: string }> {
    if (!E164.test(phone))
      throw new IdentityError(400, 'INVALID_PHONE', 'Use o formato +5511987654321.', 'phone');
    const code = this.d.random.digits(6);
    const factorId = await this.d.store.transaction(async (tx) => {
      await activeSession(tx, caller, this.d.clock.now());
      for (const f of await tx.factors(caller.userId, { includePending: true })) {
        if (f.type === 'SMS' && f.status === 'PENDING')
          await tx.updateFactor(f.id, { status: 'REMOVED' });
      }
      const factor = this.newFactor(caller.userId, 'SMS', {
        phoneEnc: this.d.fields.seal(phone, CTX.phone),
        secretEnc: this.d.random.sha256(code),
      });
      await tx.insertFactor(factor);
      return factor.id;
    });
    await this.d.messenger.sms(phone, `Seu código de confirmação: ${code}. Não compartilhe.`);
    return { factorId };
  }

  async confirmSms(caller: Caller, code: string): Promise<{ factorId: string }> {
    return this.d.store.transaction(async (tx) => {
      const now = this.d.clock.now();
      await activeSession(tx, caller, now);
      const pending = (await tx.factors(caller.userId, { includePending: true })).find(
        (f) => f.type === 'SMS' && f.status === 'PENDING',
      );
      if (
        !pending ||
        now.epochMillis - pending.createdAt.epochMillis > SMS_OTP_TTL_MS ||
        pending.secretEnc !== this.d.random.sha256(code)
      ) {
        throw invalidMfa();
      }
      // Um telefone de recuperação por vez.
      for (const f of await tx.factors(caller.userId)) {
        if (f.type === 'SMS') await tx.updateFactor(f.id, { status: 'REMOVED' });
      }
      await tx.updateFactor(pending.id, { status: 'ACTIVE', activatedAt: now, secretEnc: null });
      return { factorId: pending.id };
    });
  }

  // ---------------------------------------------------------------- listar e remover

  async list(caller: Caller) {
    return this.d.store.transaction(async (tx) =>
      (await tx.factors(caller.userId)).map((f) => ({
        id: f.id,
        type: f.type,
        activatedAt: f.activatedAt?.toString() ?? null,
      })),
    );
  }

  /** Desativar MFA é operação sensível: exige MFA nos últimos 15 min (RN-AUTHZ-003). */
  async remove(caller: Caller, factorId: string): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      const now = this.d.clock.now();
      const session = await activeSession(tx, caller, now);
      if (!hasRecentMfa(session.mfaAt, now)) throw stepUpRequired();
      const f = await tx.factorById(factorId);
      if (!f || f.userId !== caller.userId || f.status !== 'ACTIVE')
        throw new IdentityError(404, 'NOT_FOUND', 'Fator inexistente.');
      const user = await requireUser(tx, caller.userId);
      const strong = await this.strong(tx, caller.userId);
      // RN-BO-002: no backoffice, MFA forte é obrigatório; o último fator não sai.
      if (user.realm === 'backoffice' && f.type !== 'SMS' && strong.length <= 1)
        throw new IdentityError(
          422,
          'MFA_REQUIRED_IN_REALM',
          'O backoffice exige ao menos um fator forte.',
        );
      await tx.updateFactor(f.id, { status: 'REMOVED' });
    });
  }

  private async mfaEnabled(tx: IdentityTx, userId: string, at: Instant) {
    await tx.publish(
      { type: 'identity.mfa_enabled', payload: { userId, at: at.toString() } },
      userId,
    );
  }

  private newFactor(userId: string, type: FactorRow['type'], extra: Partial<FactorRow>): FactorRow {
    return {
      id: this.d.newId(),
      userId,
      type,
      status: 'PENDING',
      secretEnc: null,
      phoneEnc: null,
      credentialId: null,
      publicKey: null,
      signCount: null,
      transports: null,
      lastUsedStep: null,
      createdAt: this.d.clock.now(),
      activatedAt: null,
      ...extra,
    };
  }
}

/** RN-AUTHZ-003: falta MFA recente; o cliente faz o step-up e repete. */
export const stepUpRequired = () =>
  new IdentityError(403, 'STEP_UP_REQUIRED', 'Confirme com o segundo fator para continuar.');
