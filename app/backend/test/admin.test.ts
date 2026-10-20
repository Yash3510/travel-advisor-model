import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { createHandler } from '../src/routes.js';
import { MockBackend } from '../src/tools.js';
import { db } from '../src/db.js';
import { codeAt, fromBase32, base32, matchStep, seal, stepAt, unseal } from '../src/auth/totp.js';

let server: http.Server;
let base = '';
beforeAll(async () => {
  config.adminSecretKey = 'test-only-admin-secret-key-0123456789';
  server = http.createServer(createHandler({ catalogPath: config.catalogPath, backend: new MockBackend(config.catalogPath), modelUrl: 'http://127.0.0.1:9' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function browser() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0];
    return { status: res.status, data: await res.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { call };
}
const PW = 'monsoon trains to goa';
let n = 0;
async function account(admin = false) {
  const b = browser();
  const email = `admin-test${++n}@example.com`;
  await b.call('POST', '/api/auth/signup', { name: 'Test', email, password: PW });
  if (admin) db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(email);
  return { b, email };
}
/** an admin who has set up two-step sign-in and passed it on this browser */
async function verifiedAdmin() {
  const a = await account(true);
  const { data } = await a.b.call('POST', '/api/admin/mfa/setup');
  expect((await a.b.call('POST', '/api/admin/mfa/verify', { code: codeAt(data.secret, stepAt(Date.now())) })).status).toBe(200);
  return { ...a, secret: data.secret as string };
}

describe('two-step codes (RFC 6238)', () => {
  it('matches the RFC test vector and base32 round-trips', () => {
    const secret = base32(Buffer.from('12345678901234567890'));
    expect(codeAt(secret, stepAt(59_000))).toBe('287082'); // RFC 6238 SHA-1, T=59 → 94287082
    expect(fromBase32(secret).toString()).toBe('12345678901234567890');
  });
  it('allows ±30 s of clock drift, refuses replays and malformed codes', () => {
    const secret = base32(Buffer.from('12345678901234567890'));
    const now = 1_700_000_000_000;
    expect(matchStep(secret, codeAt(secret, stepAt(now) - 1), now)).toBe(stepAt(now) - 1);
    expect(matchStep(secret, codeAt(secret, stepAt(now) - 3), now)).toBeNull();
    expect(matchStep(secret, codeAt(secret, stepAt(now)), now, stepAt(now))).toBeNull();
    expect(matchStep(secret, '12345', now)).toBeNull();
  });
  it('seals secrets so the database never holds them in plain text', () => {
    const sealed = seal('JBSWY3DPEHPK3PXP', 'k');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(unseal(sealed, 'k')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => unseal(sealed, 'wrong key')).toThrow();
  });
});

describe('admin panel access', () => {
  it('is invisible to visitors and ordinary accounts', async () => {
    expect((await browser().call('GET', '/api/admin/overview')).status).toBe(404);
    const { b } = await account();
    expect((await b.call('GET', '/api/admin/overview')).status).toBe(404);
    expect((await b.call('GET', '/api/auth/me')).data.user.admin).toBeUndefined();
  });

  it('needs two-step sign-in, set up once, then checked per browser', async () => {
    const { b, email } = await account(true);
    expect((await b.call('GET', '/api/auth/me')).data.user.admin).toBe(true);
    expect((await b.call('GET', '/api/admin/overview')).data.error.code).toBe('mfa_required');
    expect((await b.call('GET', '/api/admin/mfa')).data).toEqual({ enrolled: false, verified: false });

    const { data } = await b.call('POST', '/api/admin/mfa/setup');
    expect(data.uri).toMatch(/^otpauth:\/\/totp\/.+secret=[A-Z2-7]+/);
    const stored = db.prepare('SELECT totp_secret FROM users WHERE email = ?').get(email) as { totp_secret: string };
    expect(stored.totp_secret).not.toContain(data.secret);

    expect((await b.call('POST', '/api/admin/mfa/verify', { code: '000000' })).data.error.code).toBe('invalid_code');
    const code = codeAt(data.secret, stepAt(Date.now()));
    expect((await b.call('POST', '/api/admin/mfa/verify', { code })).status).toBe(200);
    const overview = (await b.call('GET', '/api/admin/overview')).data;
    expect(overview.daily).toHaveLength(14);
    expect(overview.daily.at(-1)).toMatchObject({ date: new Date().toISOString().slice(0, 10) });
    expect(overview.daily.at(-1).signups).toBeGreaterThanOrEqual(1); // this test's own account, counted today
    expect((await b.call('POST', '/api/admin/mfa/verify', { code })).data.error.code).toBe('invalid_code'); // no replay
    expect((await b.call('POST', '/api/admin/mfa/setup')).status).toBe(409); // can't swap the key from the site

    // another browser signed in to the same admin account must pass the check itself
    const other = browser();
    await other.call('POST', '/api/auth/login', { email, password: PW });
    expect((await other.call('GET', '/api/admin/mfa')).data).toEqual({ enrolled: true, verified: false });
    expect((await other.call('GET', '/api/admin/users')).data.error.code).toBe('mfa_required');
  });

  it('stays off without a server key', async () => {
    const { b } = await verifiedAdmin();
    const key = config.adminSecretKey;
    config.adminSecretKey = '';
    try { expect((await b.call('GET', '/api/admin/overview')).data.error.code).toBe('admin_off'); } finally { config.adminSecretKey = key; }
  });
});

describe('admin actions', () => {
  it('turning an account off signs it out everywhere and blocks sign-in; admins cannot be turned off from the site', async () => {
    const { b: admin } = await verifiedAdmin();
    const { b: user, email } = await account();
    const id = (db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
    expect((await admin.call('POST', `/api/admin/users/${id}/disable`)).status).toBe(200);
    expect((await user.call('GET', '/api/auth/me')).data.user).toBeNull();
    expect((await browser().call('POST', '/api/auth/login', { email, password: PW })).data.error.code).toBe('account_disabled');
    expect((await admin.call('POST', `/api/admin/users/${id}/enable`)).status).toBe(200);
    expect((await browser().call('POST', '/api/auth/login', { email, password: PW })).status).toBe(200);

    const otherAdmin = await account(true);
    const adminId = (db.prepare('SELECT id FROM users WHERE email = ?').get(otherAdmin.email) as { id: number }).id;
    expect((await admin.call('POST', `/api/admin/users/${adminId}/disable`)).data.error.code).toBe('cannot_disable_admin');
  });

  it('contact messages can be marked handled; booking statuses are checked', async () => {
    const { b } = await verifiedAdmin();
    const id = Number(db.prepare("INSERT INTO contact_messages(name, email, topic, message) VALUES ('Ravi', 'ravi@example.com', 'trip', 'Need help with Goa')").run().lastInsertRowid);
    expect((await b.call('GET', '/api/admin/messages')).data.messages.find((m: { id: number }) => m.id === id).handledAt).toBeNull();
    expect((await b.call('PATCH', `/api/admin/messages/${id}`, { handled: true })).status).toBe(200);
    expect((await b.call('GET', '/api/admin/messages')).data.messages.find((m: { id: number }) => m.id === id).handledAt).not.toBeNull();
    expect((await b.call('PATCH', '/api/admin/bookings/TK-NOPE', { status: 'PAID' })).data.error.code).toBe('invalid_status');
    expect((await b.call('PATCH', '/api/admin/bookings/TK-NOPE', { status: 'CONFIRMED' })).status).toBe(404);
  });

  it('writes what admins see and change to the audit log', async () => {
    const { b } = await verifiedAdmin();
    await b.call('GET', '/api/admin/users?q=example');
    const actions = (await b.call('GET', '/api/admin/audit')).data.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['mfa_setup_started', 'mfa_enrolled', 'view_users', 'user_disabled', 'message_handled']));
  });
});
