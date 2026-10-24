import type { Instant } from '@broker/domain-kernel';
import { generateSecret, generateSync, generateURI, verifySync } from 'otplib';
import type { TotpPort } from '../application/ports.js';

/** TOTP (RFC 6238) com `otplib`: 6 dígitos, passo de 30 s, tolerância de um passo para trás. */
export class OtplibTotp implements TotpPort {
  constructor(private readonly issuer = 'Broker') {}

  newSecret(): string {
    return generateSecret();
  }

  uri(secret: string, label: string): string {
    return generateURI({ issuer: this.issuer, label, secret });
  }

  verify(secret: string, code: string, now: Instant, lastUsedStep: number | null): number | null {
    if (!/^\d{6}$/.test(code)) return null;
    const result = verifySync({
      secret,
      token: code,
      epoch: Math.floor(now.epochMillis / 1000),
      // Relógio do celular um pouco atrasado: aceita o passo anterior, nunca o futuro.
      epochTolerance: [30, 0],
      ...(lastUsedStep !== null ? { afterTimeStep: lastUsedStep } : {}),
    });
    return result.valid && 'timeStep' in result ? result.timeStep : null;
  }

  generate(secret: string, now: Instant): string {
    return generateSync({ secret, epoch: Math.floor(now.epochMillis / 1000) });
  }
}
