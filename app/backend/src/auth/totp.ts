// Two-step codes for admins (D-025): RFC 6238 TOTP (30 s, 6 digits, SHA-1) — what Google Authenticator, Authy and
// 1Password expect. Secrets are stored encrypted (AES-256-GCM, key from ADMIN_SECRET_KEY), never in plain text.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits ? out + B32[(value << (5 - bits)) & 31] : out;
}

export function fromBase32(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/[\s=]/g, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32(randomBytes(20));
export const stepAt = (ms: number) => Math.floor(ms / 30_000);

export function codeAt(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', fromBase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** The time step a code matches (clock drift of ±30 s allowed), or null. Steps at or before `lastStep` are replays. */
export function matchStep(secret: string, code: string, now: number, lastStep = -1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  for (const step of [stepAt(now), stepAt(now) - 1, stepAt(now) + 1]) {
    if (step > lastStep && timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

export const otpauthUri = (secret: string, email: string) =>
  `otpauth://totp/${encodeURIComponent(`Takeoff Admin:${email}`)}?secret=${secret}&issuer=${encodeURIComponent('Takeoff Admin')}&algorithm=SHA1&digits=6&period=30`;

const keyOf = (key: string) => createHash('sha256').update(key).digest();

export function seal(plain: string, key: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(key), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function unseal(sealed: string, key: string): string {
  const [v, iv, tag, body] = sealed.split('.');
  if (v !== 'v1') throw new Error('unknown secret format');
  const d = createDecipheriv('aes-256-gcm', keyOf(key), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
}
