// Verifies a Google Identity Services ID token (the `credential` from "Continue with Google") without a library:
// RS256 signature against Google's published keys, then issuer, audience, expiry and a verified email.
import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';
import { config } from '../config.js';

const CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
let keys: { at: number; jwks: (JsonWebKey & { kid: string })[] } | undefined;

async function jwks(force = false) {
  if (!force && keys && Date.now() - keys.at < 3_600_000) return keys.jwks;
  const res = await fetch(CERTS, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`google certs ${res.status}`);
  keys = { at: Date.now(), jwks: ((await res.json()) as { keys: (JsonWebKey & { kid: string })[] }).keys };
  return keys.jwks;
}

const b64json = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

export interface GoogleIdentity { sub: string; email: string; name: string }

export async function verifyGoogleIdToken(token: string, now = Date.now()): Promise<GoogleIdentity> {
  if (!config.googleClientId) throw new Error('Google sign-in is not configured');
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) throw new Error('malformed token');
  const header = b64json(h) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256' || !header.kid) throw new Error('unexpected token header');
  let jwk = (await jwks()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await jwks(true)).find((k) => k.kid === header.kid); // keys rotate
  if (!jwk) throw new Error('unknown signing key');
  const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('bad signature');
  const c = b64json(p) as { iss?: string; aud?: string; exp?: number; sub?: string; email?: string; email_verified?: boolean; name?: string };
  if (c.iss !== 'accounts.google.com' && c.iss !== 'https://accounts.google.com') throw new Error('wrong issuer');
  if (c.aud !== config.googleClientId) throw new Error('wrong audience');
  if (!c.exp || c.exp * 1000 < now) throw new Error('expired');
  if (!c.sub || !c.email || c.email_verified !== true) throw new Error('email not verified by Google');
  return { sub: c.sub, email: c.email.toLowerCase(), name: (c.name ?? c.email.split('@')[0]).slice(0, 100) };
}
