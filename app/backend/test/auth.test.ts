import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { createHandler } from '../src/routes.js';
import { MockBackend } from '../src/tools.js';
import { store } from '../src/db.js';
import { lastDevMail } from '../src/auth/mailer.js';
import { verifyGoogleIdToken } from '../src/auth/google.js';
import { passwordProblem } from '../src/auth/passwords.js';

let server: http.Server;
let base = '';
beforeAll(async () => {
  server = http.createServer(createHandler({ catalogPath: config.catalogPath, backend: new MockBackend(config.catalogPath), modelUrl: 'http://127.0.0.1:9' }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

/** A browser: keeps the sign-in cookie between requests. */
function browser() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = /Max-Age=0/.test(set) ? '' : set.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, setCookie: set };
  };
  return { call, get cookie() { return cookie; } };
}

let n = 0;
const email = () => `traveller${++n}@example.com`;
const PW = 'monsoon trains to goa';
const linkToken = (to: string) => /token=([\w-]+)/.exec(lastDevMail(to)!.text)![1];

describe('accounts', () => {
  it('signs up with a secure cookie, emails a one-time verification link, and knows who you are', async () => {
    const b = browser();
    const e = email();
    const r = await b.call('POST', '/api/auth/signup', { name: 'Asha', email: e, password: PW });
    expect(r.status).toBe(200);
    expect(r.setCookie).toMatch(/takeoff_auth=.+; Max-Age=\d+; Path=\/; HttpOnly; SameSite=Lax/);
    expect(r.data.user).toMatchObject({ name: 'Asha', email: e, emailVerified: false, hasPassword: true });
    const me = await b.call('GET', '/api/auth/me');
    expect(me.data.user.email).toBe(e);
    expect(me.data.sessionId).toBe(r.data.sessionId);

    const token = linkToken(e);
    expect((await b.call('POST', '/api/auth/verify', { token })).status).toBe(200);
    expect((await b.call('GET', '/api/auth/me')).data.user.emailVerified).toBe(true);
    expect((await b.call('POST', '/api/auth/verify', { token })).status).toBe(400); // single use
  });

  it('refuses weak passwords, bad emails and a second account for the same email', async () => {
    const b = browser();
    expect((await b.call('POST', '/api/auth/signup', { name: 'A', email: email(), password: 'short' })).data.error.code).toBe('weak_password');
    expect((await b.call('POST', '/api/auth/signup', { name: 'A', email: 'nope', password: PW })).data.error.code).toBe('invalid_email');
    const e = email();
    await b.call('POST', '/api/auth/signup', { name: 'A', email: e, password: PW });
    expect((await browser().call('POST', '/api/auth/signup', { name: 'B', email: e.toUpperCase(), password: PW })).status).toBe(409);
    expect(passwordProblem('password123')).toBeTruthy();
    expect(passwordProblem('asha.rao.travels', 'asha.rao@example.com')).toBeTruthy();
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const e = email();
    await browser().call('POST', '/api/auth/signup', { name: 'A', email: e, password: PW });
    const wrong = await browser().call('POST', '/api/auth/login', { email: e, password: 'not the password' });
    const unknown = await browser().call('POST', '/api/auth/login', { email: email(), password: PW });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.data).toEqual(unknown.data);
    const ok = await browser().call('POST', '/api/auth/login', { email: ` ${e.toUpperCase()} `, password: PW });
    expect(ok.status).toBe(200);
  });

  it('brings a browser\'s trips into the account, and keeps an account\'s trips from anyone signed out', async () => {
    // planned anonymously on a laptop, then signed up there
    const laptopSession = store.createSession();
    store.createThread(laptopSession, 'Goa in December');
    const laptop = browser();
    const e = email();
    const up = await laptop.call('POST', '/api/auth/signup', { name: 'A', email: e, password: PW, sessionId: laptopSession });
    expect(up.data.sessionId).toBe(laptopSession);

    // planned anonymously on a phone, then logged in there: the phone's trip joins the account
    const phoneSession = store.createSession();
    store.createThread(phoneSession, 'Kerala in July');
    const phone = browser();
    const login = await phone.call('POST', '/api/auth/login', { email: e, password: PW, sessionId: phoneSession });
    expect(login.data.sessionId).toBe(laptopSession);
    const titles = (await phone.call('GET', `/api/threads?sessionId=${laptopSession}`)).data.threads.map((t: any) => t.title).toSorted();
    expect(titles).toEqual(['Goa in December', 'Kerala in July']);

    // the session id alone is not enough once it belongs to an account
    const stranger = browser();
    expect((await stranger.call('GET', `/api/threads?sessionId=${laptopSession}`)).data.threads).toEqual([]);
    const threadId = (await phone.call('GET', `/api/threads?sessionId=${laptopSession}`)).data.threads[0].id;
    expect((await stranger.call('GET', `/api/threads/${threadId}/messages?sessionId=${laptopSession}`)).status).toBe(404);
    expect((await stranger.call('GET', `/api/profile?sessionId=${laptopSession}`)).status).toBe(404);
    expect((await stranger.call('DELETE', `/api/threads/${threadId}?sessionId=${laptopSession}`)).status).toBe(404);
    // nor the old phone session id
    expect((await stranger.call('GET', `/api/threads?sessionId=${phoneSession}`)).data.threads).toEqual([]);
  });

  it('resets a forgotten password with a one-time link and signs out other browsers', async () => {
    const e = email();
    const first = browser();
    await first.call('POST', '/api/auth/signup', { name: 'A', email: e, password: PW });
    expect((await browser().call('POST', '/api/auth/forgot', { email: email() })).data).toEqual({ ok: true }); // unknown: same answer
    await browser().call('POST', '/api/auth/forgot', { email: e });
    const token = linkToken(e);
    const other = browser();
    // a weak password does not use up the link
    expect((await other.call('POST', '/api/auth/reset', { token, password: 'short' })).data.error.code).toBe('weak_password');
    const done = await other.call('POST', '/api/auth/reset', { token, password: 'a brand new phrase here' });
    expect(done.status).toBe(200);
    expect(done.data.user.emailVerified).toBe(true);
    expect((await first.call('GET', '/api/auth/me')).data.user).toBeNull(); // signed out elsewhere
    expect((await other.call('POST', '/api/auth/reset', { token, password: 'another new phrase' })).status).toBe(400); // single use
    expect((await browser().call('POST', '/api/auth/login', { email: e, password: 'a brand new phrase here' })).status).toBe(200);
  });

  it('manages the account: rename, change password, export, sign out, delete', async () => {
    const e = email();
    const b = browser();
    const session = store.createSession();
    store.createThread(session, 'Ladakh in June');
    await b.call('POST', '/api/auth/signup', { name: 'A', email: e, password: PW, sessionId: session });
    expect((await b.call('PATCH', '/api/account', { name: '  Asha  Rao ' })).data.user.name).toBe('Asha Rao');
    expect((await b.call('POST', '/api/account/password', { currentPassword: 'wrong one here', newPassword: 'fresh phrase for trips' })).status).toBe(403);
    expect((await b.call('POST', '/api/account/password', { currentPassword: PW, newPassword: 'fresh phrase for trips' })).status).toBe(200);

    const exp = await b.call('GET', '/api/account/export');
    expect(exp.data.account.email).toBe(e);
    expect(exp.data.trips.map((t: any) => t.title)).toEqual(['Ladakh in June']);

    expect((await b.call('DELETE', '/api/account', { password: PW })).status).toBe(403); // the old password no longer works
    expect((await b.call('DELETE', '/api/account', { password: 'fresh phrase for trips' })).status).toBe(200);
    expect((await b.call('GET', '/api/auth/me')).data.user).toBeNull();
    expect(store.sessionExists(session)).toBe(false);
    expect((await browser().call('POST', '/api/auth/login', { email: e, password: 'fresh phrase for trips' })).status).toBe(401);

    const c = browser();
    await c.call('POST', '/api/auth/signup', { name: 'B', email: email(), password: PW });
    await c.call('POST', '/api/auth/logout');
    expect((await c.call('GET', '/api/auth/me')).data.user).toBeNull();
    expect((await c.call('GET', '/api/account/export')).status).toBe(401);
  });

  it('refuses account changes from another site', async () => {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    // allowed origins default to "*" in tests; with a list, other origins get 403
    expect([401, 403]).toContain(res.status);
    const old = config.allowedOrigins;
    config.allowedOrigins = ['https://takeoff.example'];
    try {
      const blocked = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
      expect(blocked.status).toBe(403);
    } finally { config.allowedOrigins = old; }
  });
});

const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('Google sign-in', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const token = (claims: Record<string, unknown>, kid = 'k1') => {
    const head = enc({ alg: 'RS256', kid, typ: 'JWT' });
    const body = enc({ iss: 'https://accounts.google.com', aud: 'client-123', exp: Math.floor(Date.now() / 1000) + 600, sub: 'g-1', email: 'g@example.com', email_verified: true, name: 'Gita', ...claims });
    return `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url')}`;
  };

  it('accepts only a token signed by Google, for this app, unexpired, with a verified email', async () => {
    config.googleClientId = 'client-123';
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => (String(url).includes('googleapis.com/oauth2/v3/certs') ? new Response(JSON.stringify({ keys: [jwk] })) : real(url, init)));
    try {
      expect(await verifyGoogleIdToken(token({}))).toEqual({ sub: 'g-1', email: 'g@example.com', name: 'Gita' });
      await expect(verifyGoogleIdToken(token({ aud: 'someone-else' }))).rejects.toThrow('audience');
      await expect(verifyGoogleIdToken(token({ exp: 1 }))).rejects.toThrow('expired');
      await expect(verifyGoogleIdToken(token({ email_verified: false }))).rejects.toThrow('verified');
      const forged = token({}).split('.');
      forged[1] = Buffer.from(JSON.stringify({ iss: 'accounts.google.com', aud: 'client-123', exp: 9e9, sub: 'x', email: 'x@example.com', email_verified: true })).toString('base64url');
      await expect(verifyGoogleIdToken(forged.join('.'))).rejects.toThrow('signature');

      // the endpoint: a new Google user gets a verified account; the same email later links to it
      const b = browser();
      const r = await b.call('POST', '/api/auth/google', { credential: token({}) });
      expect(r.status).toBe(200);
      expect(r.data.user).toMatchObject({ email: 'g@example.com', emailVerified: true, google: true, hasPassword: false });
      expect((await browser().call('POST', '/api/auth/google', { credential: 'junk' })).status).toBe(401);
      // a Google-only account confirms deletion by typing DELETE
      expect((await b.call('DELETE', '/api/account', { confirm: 'nope' })).status).toBe(403);
      expect((await b.call('DELETE', '/api/account', { confirm: 'DELETE' })).status).toBe(200);
    } finally {
      vi.unstubAllGlobals();
      config.googleClientId = '';
    }
  });
});

describe('account security (D-022)', () => {
  it('changes the email only after the new address confirms, and tells the old one', async () => {
    const b = browser();
    const old = email();
    await b.call('POST', '/api/auth/signup', { name: 'A', email: old, password: PW });
    const taken = email();
    await browser().call('POST', '/api/auth/signup', { name: 'B', email: taken, password: PW });
    expect((await b.call('POST', '/api/account/email', { newEmail: email(), password: 'wrong one here' })).status).toBe(403);
    expect((await b.call('POST', '/api/account/email', { newEmail: taken, password: PW })).data.error.code).toBe('email_taken');

    const next = email();
    expect((await b.call('POST', '/api/account/email', { newEmail: next, password: PW })).data).toEqual({ ok: true, pendingEmail: next });
    expect(lastDevMail(old)!.subject).toBe('Your Takeoff email is being changed');
    expect((await b.call('GET', '/api/auth/me')).data.user.email).toBe(old); // not until confirmed
    const token = /token=([\w-]+)/.exec(lastDevMail(next)!.text)![1];
    expect((await browser().call('POST', '/api/auth/confirm-email', { token })).status).toBe(200);
    expect((await b.call('GET', '/api/auth/me')).data.user).toMatchObject({ email: next, emailVerified: true });
    expect((await browser().call('POST', '/api/auth/login', { email: next, password: PW })).status).toBe(200);
    expect((await browser().call('POST', '/api/auth/confirm-email', { token })).status).toBe(400); // single use
  });

  it('lists signed-in devices and signs out one, or all the others', async () => {
    const e = email();
    const laptop = browser();
    await laptop.call('POST', '/api/auth/signup', { name: 'A', email: e, password: PW });
    const phone = browser();
    const tablet = browser();
    await phone.call('POST', '/api/auth/login', { email: e, password: PW });
    await tablet.call('POST', '/api/auth/login', { email: e, password: PW });
    const list = (await laptop.call('GET', '/api/account/sessions')).data.sessions;
    expect(list).toHaveLength(3);
    expect(list.filter((s: any) => s.current)).toHaveLength(1);
    const phoneId = (await phone.call('GET', '/api/account/sessions')).data.sessions.find((s: any) => s.current).id;
    expect((await laptop.call('DELETE', `/api/account/sessions/${phoneId}`)).data.sessions).toHaveLength(2);
    expect((await phone.call('GET', '/api/auth/me')).data.user).toBeNull();
    await laptop.call('POST', '/api/account/sessions/sign-out-others');
    expect((await tablet.call('GET', '/api/auth/me')).data.user).toBeNull();
    expect((await laptop.call('GET', '/api/account/sessions')).data.sessions).toHaveLength(1);
  });

  it('locks an email after five wrong passwords, known or not, until a reset', async () => {
    const e = email();
    await browser().call('POST', '/api/auth/signup', { name: 'A', email: e, password: PW });
    for (let i = 0; i < 5; i++) expect((await browser().call('POST', '/api/auth/login', { email: e, password: `wrong guess ${i}` })).status).toBe(401);
    const locked = await browser().call('POST', '/api/auth/login', { email: e, password: PW });
    expect(locked.status).toBe(429);
    expect(locked.data.error.code).toBe('account_locked');
    const ghost = email();
    for (let i = 0; i < 5; i++) await browser().call('POST', '/api/auth/login', { email: ghost, password: `x${i} guesses` });
    expect((await browser().call('POST', '/api/auth/login', { email: ghost, password: PW })).data.error.code).toBe('account_locked');
    // a password reset proves the owner and unlocks
    await browser().call('POST', '/api/auth/forgot', { email: e });
    const token = /token=([\w-]+)/.exec(lastDevMail(e)!.text)![1];
    expect((await browser().call('POST', '/api/auth/reset', { token, password: 'unlocked new phrase' })).status).toBe(200);
    expect((await browser().call('POST', '/api/auth/login', { email: e, password: 'unlocked new phrase' })).status).toBe(200);
  });

  it('refuses breached passwords, and allows when the breach service is down', async () => {
    const { createHash } = await import('node:crypto');
    const sha1 = createHash('sha1').update('rainy goa monsoon').digest('hex').toUpperCase();
    config.pwnedCheck = true;
    const real = globalThis.fetch;
    let down = false;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (!String(url).includes('pwnedpasswords.com')) return real(url, init);
      if (down) throw new Error('offline');
      expect(String(url)).toMatch(new RegExp(`/range/${sha1.slice(0, 5)}$`)); // only the prefix leaves
      return new Response(`0000000000000000000000000000000000A:0\r\n${sha1.slice(5)}:42\r\n`);
    });
    try {
      const r = await browser().call('POST', '/api/auth/signup', { name: 'A', email: email(), password: 'rainy goa monsoon' });
      expect(r.data.error).toMatchObject({ code: 'weak_password', message: expect.stringContaining('data breach') });
      down = true;
      expect((await browser().call('POST', '/api/auth/signup', { name: 'A', email: email(), password: 'rainy goa monsoon' })).status).toBe(200);
    } finally { vi.unstubAllGlobals(); config.pwnedCheck = false; }
  });

  it('asks for the bot check on sign-up, reset and contact once Turnstile is set', async () => {
    config.turnstileSecret = 'secret';
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (!String(url).includes('challenges.cloudflare.com')) return real(url, init);
      return new Response(JSON.stringify({ success: new URLSearchParams(String(init!.body)).get('response') === 'good' }));
    });
    try {
      expect((await browser().call('POST', '/api/auth/signup', { name: 'A', email: email(), password: PW })).data.error.code).toBe('bot_check');
      expect((await browser().call('POST', '/api/auth/forgot', { email: email(), turnstileToken: 'bad' })).data.error.code).toBe('bot_check');
      expect((await browser().call('POST', '/api/contact', { name: 'A', email: 'a@b.co', topic: 'trip', message: 'hello there' })).data.error.code).toBe('bot_check');
      expect((await browser().call('POST', '/api/auth/signup', { name: 'A', email: email(), password: PW, turnstileToken: 'good' })).status).toBe(200);
    } finally { vi.unstubAllGlobals(); config.turnstileSecret = ''; }
  });

  it('keeps rate-limit counters in the database and sends no referrer', async () => {
    const { db } = await import('../src/db.js');
    const before = (db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE key LIKE 'forgot:%'").get() as { n: number }).n;
    const r = await fetch(base + '/api/auth/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email() }) });
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const after = (db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE key LIKE 'forgot:%'").get() as { n: number }).n;
    expect(after).toBe(before + 1);
  });
});
