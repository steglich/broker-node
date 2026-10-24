import { createHash } from 'node:crypto';

/** `code_verifier` do PKCE (RFC 7636 §4.1): 43 a 128 caracteres não reservados. */
export const isCodeVerifier = (v: string): boolean => /^[A-Za-z0-9._~-]{43,128}$/.test(v);

/** `code_challenge` S256: BASE64URL(SHA256(verifier)). O método `plain` não é aceito (OAuth 2.1). */
export const s256 = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

export const pkceMatches = (verifier: string, challenge: string): boolean =>
  isCodeVerifier(verifier) && s256(verifier) === challenge;
