// Password hashing with scrypt (memory-hard, built into Node). Stored as scrypt$N$r$p$salt$hash (base64).
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 2 ** 15, R = 8, P = 1, KEYLEN = 64;
const derive = (password: string, salt: Buffer, o: ScryptOptions) =>
  new Promise<Buffer>((ok, no) => scrypt(password.normalize('NFKC'), salt, KEYLEN, { ...o, maxmem: 128 * o.N! * o.r! * 2 }, (e, k) => (e ? no(e) : ok(k))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    await derive(password, randomBytes(16), { N, r: R, p: P }); // same work either way: no timing hint that the account has no password
    return false;
  }
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Short, common or email-like passwords are refused (NIST 800-63B: length over composition rules).
const COMMON = new Set(['password', 'password1', 'password123', '1234567890', '12345678', '123456789', 'qwertyuiop', 'iloveyou', 'travel123', 'takeoff123', 'letmein123', 'welcome123', 'india12345', 'abcdefghij']);
export function passwordProblem(password: string, email = ''): string | null {
  if (password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 200) return 'Use at most 200 characters.';
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) return 'That password is too common. Try a short phrase.';
  if (email && lower.includes(email.toLowerCase().split('@')[0]) && email.split('@')[0].length >= 4) return "Don't use your email address in your password.";
  return null;
}
