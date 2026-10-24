import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { WebAuthnPort } from '../application/ports.js';

export interface WebAuthnSettings {
  rpName: string;
  /** Domínio do site (ex.: `broker.localhost`). */
  rpId: string;
  /** Origens aceitas (ex.: `https://app.broker.localhost`). */
  origins: string[];
}

type Transports = NonNullable<
  NonNullable<
    Parameters<typeof generateAuthenticationOptions>[0]['allowCredentials']
  >[number]['transports']
>;
const transports = (t: string[]) => t as Transports;

/** WebAuthn/FIDO2 com `@simplewebauthn/server` (RN-AUTH-003): chave de segurança ou biometria. */
export class SimpleWebAuthn implements WebAuthnPort {
  constructor(private readonly s: WebAuthnSettings) {}

  async registrationOptions(user: { id: string; name: string }, exclude: string[]) {
    const options = await generateRegistrationOptions({
      rpName: this.s.rpName,
      rpID: this.s.rpId,
      userName: user.name,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: exclude.map((id) => ({ id })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    return { options, challenge: options.challenge };
  }

  async verifyRegistration(response: unknown, challenge: string) {
    try {
      const result = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: this.s.origins,
        expectedRPID: this.s.rpId,
        requireUserVerification: true,
      });
      if (!result.verified) return null;
      const { credential } = result.registrationInfo;
      return {
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        signCount: credential.counter,
        transports: credential.transports ?? [],
      };
    } catch {
      return null;
    }
  }

  async authenticationOptions(allow: { credentialId: string; transports: string[] }[]) {
    const options = await generateAuthenticationOptions({
      rpID: this.s.rpId,
      allowCredentials: allow.map((c) => ({
        id: c.credentialId,
        transports: transports(c.transports),
      })),
      userVerification: 'required',
    });
    return { options, challenge: options.challenge };
  }

  async verifyAuthentication(
    response: unknown,
    challenge: string,
    credential: { credentialId: string; publicKey: string; signCount: number },
  ) {
    try {
      const result = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: this.s.origins,
        expectedRPID: this.s.rpId,
        credential: {
          id: credential.credentialId,
          publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
          counter: credential.signCount,
        },
        requireUserVerification: true,
      });
      return result.verified ? { signCount: result.authenticationInfo.newCounter } : null;
    } catch {
      return null;
    }
  }
}
