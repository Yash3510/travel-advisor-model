// /api/auth/* and /api/account/* (D-021). The browser holds an HttpOnly cookie; the database holds only its hash.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { HttpError, json, readBody, rateLimited, str } from '../http.js';
import { log } from '../log.js';
import { accounts, publicUser, type UserRow } from './accounts.js';
import { verifyGoogleIdToken } from './google.js';
import { resetMail, sendMail, verifyMail } from './mailer.js';
import { hashPassword, passwordProblem, verifyPassword } from './passwords.js';

const COOKIE = 'takeoff_auth';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const oneLine = (v: unknown, max: number) => str(v).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function cookieToken(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** The signed-in user of a request, if any. */
export const currentUser = (req: IncomingMessage): UserRow | undefined => accounts.userForToken(cookieToken(req));

function setCookie(res: ServerResponse, token: string | null) {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', ...(config.cookieSecure ? ['Secure'] : [])];
  res.setHeader('Set-Cookie', token
    ? `${COOKIE}=${encodeURIComponent(token)}; Max-Age=${config.authSessionDays * 86400}; ${attrs.join('; ')}`
    : `${COOKIE}=; Max-Age=0; ${attrs.join('; ')}`);
}

/** Sign the browser in and give it the account's chat session (bringing this browser's trips along). */
function signIn(res: ServerResponse, user: UserRow, browserSession: string) {
  setCookie(res, accounts.startSession(user.id));
  const sessionId = accounts.adopt(user.id, browserSession || undefined);
  json(res, 200, { user: publicUser(accounts.byId(user.id)!), sessionId });
}

async function sendVerification(user: UserRow) {
  const token = accounts.emailToken(user.id, 'verify', 24 * 3_600_000);
  await sendMail(verifyMail(user.email, user.name, `${config.appUrl}/verify-email?token=${token}`))
    .catch((err) => log('error', 'verification email failed', { error: (err as Error).message }));
}

/** Handles the account endpoints; false when the path is not one of them. */
export async function handleAuth(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith('/api/auth/') && pathname !== '/api/account' && !pathname.startsWith('/api/account/')) return false;
  const method = req.method ?? 'GET';
  // state changes only from the site itself (cookies are SameSite=Lax as well)
  const origin = req.headers.origin;
  if (method !== 'GET' && origin && !config.allowedOrigins.includes('*') && !config.allowedOrigins.includes(origin)) {
    throw new HttpError(403, 'forbidden_origin', 'Requests must come from the Takeoff site.');
  }
  const need = (m: string) => { if (method !== m) { res.setHeader('Allow', m); throw new HttpError(405, 'method_not_allowed', `Use ${m}.`); } };
  const limit = (bucket: string, perMin: number) => { if (rateLimited(req, bucket, perMin * config.authRateScale)) throw new HttpError(429, 'rate_limited', 'Too many attempts. Please wait a minute and try again.'); };
  const signedIn = () => { const u = currentUser(req); if (!u) throw new HttpError(401, 'not_signed_in', 'Please sign in.'); return u; };

  switch (pathname) {
    case '/api/auth/config': {
      need('GET');
      json(res, 200, { googleClientId: config.googleClientId || null });
      return true;
    }
    case '/api/auth/me': {
      need('GET');
      const user = currentUser(req);
      json(res, 200, user ? { user: publicUser(user), sessionId: accounts.adopt(user.id) } : { user: null });
      return true;
    }
    case '/api/auth/signup': {
      need('POST');
      limit('signup', 5);
      const b = await readBody(req);
      const name = oneLine(b.name, 100);
      const email = oneLine(b.email, 200).toLowerCase();
      const password = str(b.password);
      if (!name) throw new HttpError(400, 'invalid_name', 'Please tell us your name.');
      if (!EMAIL_RE.test(email)) throw new HttpError(400, 'invalid_email', 'Please enter a valid email address.');
      const problem = passwordProblem(password, email);
      if (problem) throw new HttpError(400, 'weak_password', problem);
      if (accounts.byEmail(email)) throw new HttpError(409, 'email_taken', 'An account with this email already exists. Log in instead.');
      const user = accounts.create({ email, name, passwordHash: await hashPassword(password) });
      await sendVerification(user);
      log('info', 'account created', { userId: user.id });
      signIn(res, user, str(b.sessionId));
      return true;
    }
    case '/api/auth/login': {
      need('POST');
      const b = await readBody(req);
      const email = oneLine(b.email, 200).toLowerCase();
      limit('login', 10);
      limit(`login:${email}`, 10);
      const user = accounts.byEmail(email);
      // the same work and the same answer whether or not the account exists
      const ok = await verifyPassword(str(b.password), user?.password_hash);
      if (!user || !ok) throw new HttpError(401, 'invalid_login', 'That email and password don\'t match.');
      signIn(res, user, str(b.sessionId));
      return true;
    }
    case '/api/auth/google': {
      need('POST');
      limit('google', 10);
      const b = await readBody(req);
      let id;
      try { id = await verifyGoogleIdToken(str(b.credential)); } catch (err) {
        log('info', 'google sign-in rejected', { reason: (err as Error).message });
        throw new HttpError(401, 'invalid_google', 'Google sign-in did not work. Please try again.');
      }
      let user = accounts.byGoogle(id.sub);
      if (!user) {
        const existing = accounts.byEmail(id.email);
        // Google vouches for the address, so an account with that email is the same person
        if (existing) { accounts.linkGoogle(existing.id, id.sub); accounts.markVerified(existing.id); user = accounts.byId(existing.id)!; }
        else user = accounts.create({ email: id.email, name: id.name, googleSub: id.sub, verified: true });
      }
      signIn(res, user, str(b.sessionId));
      return true;
    }
    case '/api/auth/logout': {
      need('POST');
      const token = cookieToken(req);
      if (token) accounts.endSession(token);
      setCookie(res, null);
      json(res, 200, { ok: true });
      return true;
    }
    case '/api/auth/verify': {
      need('POST');
      limit('verify', 10);
      const user = accounts.useEmailToken(str((await readBody(req)).token), 'verify');
      if (!user) throw new HttpError(400, 'invalid_token', 'This link has expired or was already used.');
      accounts.markVerified(user.id);
      json(res, 200, { ok: true });
      return true;
    }
    case '/api/auth/resend-verification': {
      need('POST');
      limit('resend', 3);
      const user = signedIn();
      if (!user.email_verified_at) await sendVerification(user);
      json(res, 200, { ok: true });
      return true;
    }
    case '/api/auth/forgot': {
      need('POST');
      limit('forgot', 5);
      const user = accounts.byEmail(oneLine((await readBody(req)).email, 200));
      if (user) {
        const token = accounts.emailToken(user.id, 'reset', 3_600_000);
        await sendMail(resetMail(user.email, user.name, `${config.appUrl}/reset-password?token=${token}`))
          .catch((err) => log('error', 'reset email failed', { error: (err as Error).message }));
      }
      // the same answer either way: whether an email has an account is not revealed here
      json(res, 200, { ok: true });
      return true;
    }
    case '/api/auth/reset': {
      need('POST');
      limit('reset', 10);
      const b = await readBody(req);
      const password = str(b.password);
      const valid = accounts.peekEmailToken(str(b.token), 'reset');
      if (!valid) throw new HttpError(400, 'invalid_token', 'This link has expired or was already used.');
      // check the new password before using up the link, so a weak one doesn't cost the customer their link
      const problem = passwordProblem(password, valid.email);
      if (problem) throw new HttpError(400, 'weak_password', problem);
      const pending = accounts.useEmailToken(str(b.token), 'reset');
      if (!pending) throw new HttpError(400, 'invalid_token', 'This link has expired or was already used.');
      accounts.setPassword(pending.id, await hashPassword(password));
      accounts.markVerified(pending.id); // they proved they read that inbox
      accounts.endOtherSessions(pending.id);
      signIn(res, pending, str(b.sessionId));
      return true;
    }
    case '/api/account': {
      const user = signedIn();
      if (method === 'PATCH') {
        const name = oneLine((await readBody(req)).name, 100);
        if (!name) throw new HttpError(400, 'invalid_name', 'Please enter a name.');
        accounts.setName(user.id, name);
        json(res, 200, { user: publicUser(accounts.byId(user.id)!) });
        return true;
      }
      if (method === 'DELETE') {
        const b = await readBody(req);
        // confirm with the password, or by typing DELETE for accounts that only use Google
        const confirmed = user.password_hash ? await verifyPassword(str(b.password), user.password_hash) : str(b.confirm) === 'DELETE';
        if (!confirmed) throw new HttpError(403, 'not_confirmed', user.password_hash ? 'That password is not right.' : 'Type DELETE to confirm.');
        accounts.delete(user.id);
        setCookie(res, null);
        log('info', 'account deleted', { userId: user.id });
        json(res, 200, { ok: true });
        return true;
      }
      res.setHeader('Allow', 'PATCH, DELETE');
      throw new HttpError(405, 'method_not_allowed', 'Use PATCH or DELETE.');
    }
    case '/api/account/password': {
      need('POST');
      limit('password', 5);
      const user = signedIn();
      const b = await readBody(req);
      if (user.password_hash && !(await verifyPassword(str(b.currentPassword), user.password_hash))) throw new HttpError(403, 'wrong_password', 'Your current password is not right.');
      const problem = passwordProblem(str(b.newPassword), user.email);
      if (problem) throw new HttpError(400, 'weak_password', problem);
      accounts.setPassword(user.id, await hashPassword(str(b.newPassword)));
      accounts.endOtherSessions(user.id, cookieToken(req)); // other browsers sign in again
      json(res, 200, { user: publicUser(accounts.byId(user.id)!) });
      return true;
    }
    case '/api/account/export': {
      need('GET');
      const user = signedIn();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="takeoff-data-${new Date().toISOString().slice(0, 10)}.json"`,
        'Cache-Control': 'no-store',
      }).end(JSON.stringify(accounts.export(user.id), null, 2));
      return true;
    }
    default:
      throw new HttpError(404, 'not_found', 'Not found.');
  }
}
