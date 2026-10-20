// Accounts (D-021): users, signed-in browsers, one-time email links, and the chat session each user owns.
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { db, store } from '../db.js';

export interface UserRow {
  id: number; email: string; name: string; password_hash: string | null; google_sub: string | null;
  email_verified_at: string | null; session_id: string | null; created_at: string;
  role: 'user' | 'admin'; disabled_at: string | null;
  totp_secret: string | null; totp_enabled_at: string | null; totp_last_step: number | null;
}

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const sqlTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const toIso = (sqliteUtc: string) => new Date(sqliteUtc.replace(' ', 'T') + 'Z').toISOString();

/** What the client may see about a user. */
export const publicUser = (u: UserRow) => ({
  id: u.id, name: u.name, email: u.email, emailVerified: !!u.email_verified_at,
  hasPassword: !!u.password_hash, google: !!u.google_sub, createdAt: toIso(u.created_at),
  ...(u.role === 'admin' ? { admin: true as const } : {}),
});
export type PublicUser = ReturnType<typeof publicUser>;

export const accounts = {
  byId: (id: number) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined,
  byEmail: (email: string) => db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email.trim()) as UserRow | undefined,
  byGoogle: (sub: string) => db.prepare('SELECT * FROM users WHERE google_sub = ?').get(sub) as UserRow | undefined,

  create(u: { email: string; name: string; passwordHash?: string; googleSub?: string; verified?: boolean }): UserRow {
    const info = db.prepare("INSERT INTO users(email, name, password_hash, google_sub, email_verified_at) VALUES (?, ?, ?, ?, CASE WHEN ? THEN datetime('now') END)")
      .run(u.email.trim().toLowerCase(), u.name, u.passwordHash ?? null, u.googleSub ?? null, u.verified ? 1 : 0);
    return accounts.byId(Number(info.lastInsertRowid))!;
  },
  setName: (id: number, name: string) => db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id),
  setPassword: (id: number, hash: string) => db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id),
  markVerified: (id: number) => db.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?").run(id),
  linkGoogle: (id: number, sub: string) => db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(sub, id),

  // ── failed log-ins (D-022): 5 failures lock an email for 15 minutes, 10 for an hour ──
  /** Seconds until this email may try again, or 0. */
  lockedFor(email: string): number {
    const row = db.prepare("SELECT CAST(strftime('%s', locked_until) - strftime('%s', 'now') AS INTEGER) AS s FROM login_failures WHERE email = ? AND locked_until > datetime('now')").get(email.trim()) as { s: number } | undefined;
    return row ? Math.max(1, row.s) : 0;
  },
  recordFailure(email: string) {
    db.prepare(`INSERT INTO login_failures(email, count) VALUES (?, 1)
      ON CONFLICT(email) DO UPDATE SET count = CASE WHEN last_at < datetime('now', '-1 day') THEN 1 ELSE count + 1 END, last_at = datetime('now')`).run(email.trim());
    db.prepare(`UPDATE login_failures SET locked_until = datetime('now', CASE WHEN count >= 10 THEN '+60 minutes' ELSE '+15 minutes' END)
      WHERE email = ? AND count >= 5 AND count % 5 = 0`).run(email.trim());
  },
  clearFailures: (email: string) => db.prepare('DELETE FROM login_failures WHERE email = ?').run(email.trim()),

  // ── signed-in browsers ──
  /** A new sign-in: returns the cookie's token (only its hash is stored). */
  startSession(userId: number, userAgent = ''): string {
    const token = newToken();
    db.prepare("DELETE FROM auth_sessions WHERE expires_at < datetime('now')").run();
    db.prepare("INSERT INTO auth_sessions(token_hash, user_id, expires_at, user_agent, last_seen_at) VALUES (?, ?, ?, ?, datetime('now'))")
      .run(sha256(token), userId, sqlTime(Date.now() + config.authSessionDays * 86_400_000), userAgent.slice(0, 300));
    return token;
  },
  userForToken(token: string | undefined): UserRow | undefined {
    if (!token) return undefined;
    const hash = sha256(token);
    const row = db.prepare("SELECT user_id FROM auth_sessions WHERE token_hash = ? AND expires_at > datetime('now')").get(hash) as { user_id: number } | undefined;
    if (!row) return undefined;
    const user = accounts.byId(row.user_id);
    if (!user || user.disabled_at) return undefined; // a disabled account is signed out everywhere at once
    // "last used", at most one write per browser every five minutes
    db.prepare("UPDATE auth_sessions SET last_seen_at = datetime('now') WHERE token_hash = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-5 minutes'))").run(hash);
    return user;
  },
  /** This browser passed the admin two-step check within the last `hours` (D-025). */
  mfaFresh(token: string | undefined, hours: number): boolean {
    if (!token) return false;
    return !!db.prepare("SELECT 1 FROM auth_sessions WHERE token_hash = ? AND mfa_at > datetime('now', ?)").get(sha256(token), `-${hours} hours`);
  },
  markMfa(token: string) {
    db.prepare("UPDATE auth_sessions SET mfa_at = datetime('now') WHERE token_hash = ?").run(sha256(token));
  },
  /** Where the account is signed in, newest use first; `id` is a short handle for signing one out. */
  listSessions(userId: number, currentToken?: string) {
    const current = currentToken ? sha256(currentToken) : '';
    return (db.prepare("SELECT token_hash, user_agent, created_at, last_seen_at FROM auth_sessions WHERE user_id = ? AND expires_at > datetime('now') ORDER BY COALESCE(last_seen_at, created_at) DESC")
      .all(userId) as { token_hash: string; user_agent: string | null; created_at: string; last_seen_at: string | null }[])
      .map((r) => ({ id: r.token_hash.slice(0, 16), current: r.token_hash === current, userAgent: r.user_agent ?? '', createdAt: toIso(r.created_at), lastSeenAt: toIso(r.last_seen_at ?? r.created_at) }));
  },
  endSessionById: (userId: number, id: string) =>
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?').run(userId, id).changes > 0,
  endSession: (token: string) => db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token)),
  /** Sign out everywhere, except the browser holding `keep`. */
  endOtherSessions: (userId: number, keep?: string) =>
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?').run(userId, keep ? sha256(keep) : ''),

  // ── changing the email address: confirmed from the new inbox (D-022) ──
  emailChange(userId: number, newEmail: string): string {
    const token = newToken();
    db.prepare('DELETE FROM email_changes WHERE user_id = ? AND used_at IS NULL').run(userId);
    db.prepare('INSERT INTO email_changes(token_hash, user_id, new_email, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, newEmail, sqlTime(Date.now() + 24 * 3_600_000));
    return token;
  },
  /** Apply a confirmed change; 'taken' if someone else registered that address meanwhile. */
  confirmEmailChange(token: string): UserRow | 'taken' | undefined {
    return db.transaction(() => {
      const row = db.prepare("SELECT user_id, new_email FROM email_changes WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')").get(sha256(token)) as { user_id: number; new_email: string } | undefined;
      if (!row) return undefined;
      db.prepare("UPDATE email_changes SET used_at = datetime('now') WHERE token_hash = ?").run(sha256(token));
      const other = accounts.byEmail(row.new_email);
      if (other && other.id !== row.user_id) return 'taken' as const;
      db.prepare("UPDATE users SET email = ?, email_verified_at = datetime('now') WHERE id = ?").run(row.new_email, row.user_id);
      return accounts.byId(row.user_id);
    })();
  },

  // ── one-time email links ──
  emailToken(userId: number, purpose: 'verify' | 'reset', ttlMs: number): string {
    const token = newToken();
    // a new link replaces the older unused ones for the same purpose
    db.prepare('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(userId, purpose);
    db.prepare('INSERT INTO email_tokens(token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, purpose, sqlTime(Date.now() + ttlMs));
    return token;
  },
  /** The user a link belongs to, without using it up (to check a new password first). */
  peekEmailToken(token: string, purpose: 'verify' | 'reset'): UserRow | undefined {
    const row = db.prepare("SELECT user_id FROM email_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > datetime('now')").get(sha256(token), purpose) as { user_id: number } | undefined;
    return row && accounts.byId(row.user_id);
  },
  /** The user a link belongs to, if it is the right kind, unused and not expired; it is used up either way. */
  useEmailToken(token: string, purpose: 'verify' | 'reset'): UserRow | undefined {
    return db.transaction(() => {
      const row = db.prepare("SELECT user_id FROM email_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > datetime('now')").get(sha256(token), purpose) as { user_id: number } | undefined;
      if (!row) return undefined;
      db.prepare("UPDATE email_tokens SET used_at = datetime('now') WHERE token_hash = ?").run(sha256(token));
      return accounts.byId(row.user_id);
    })();
  },

  // ── the chat session an account owns ──
  /** The account that owns a chat session, or null for an anonymous one. */
  sessionOwner: (sessionId: string) => (db.prepare('SELECT user_id FROM sessions WHERE session_id = ?').get(sessionId) as { user_id: number | null } | undefined)?.user_id ?? null,

  /**
   * Give the signed-in user their chat session, bringing along the trips (and, if the account has none yet, the
   * preferences) of the anonymous session this browser was using. Returns the session id the client should use.
   */
  adopt(userId: number, browserSession?: string): string {
    return db.transaction(() => {
      const user = accounts.byId(userId)!;
      const usable = !!browserSession && store.sessionExists(browserSession) && [null, userId].includes(accounts.sessionOwner(browserSession));
      let own = user.session_id;
      if (!own) {
        own = usable ? browserSession! : store.createSession();
        db.prepare('UPDATE users SET session_id = ? WHERE id = ?').run(own, userId);
      } else if (usable && browserSession !== own) {
        db.prepare('UPDATE threads SET session_id = ? WHERE session_id = ?').run(own, browserSession);
        const hasProfile = db.prepare('SELECT 1 FROM profiles WHERE session_id = ?').get(own);
        if (!hasProfile) db.prepare('UPDATE profiles SET session_id = ? WHERE session_id = ?').run(own, browserSession);
      }
      for (const sid of [own, ...(usable ? [browserSession!] : [])]) db.prepare('UPDATE sessions SET user_id = ? WHERE session_id = ?').run(userId, sid);
      return own;
    })();
  },

  /** Everything stored about a user, for "Download my data". */
  export(userId: number) {
    const user = accounts.byId(userId)!;
    const sessions = (db.prepare('SELECT session_id FROM sessions WHERE user_id = ?').all(userId) as { session_id: string }[]).map((r) => r.session_id);
    const threads = sessions.flatMap((sid) => store.listThreads(sid));
    return {
      exportedAt: new Date().toISOString(),
      account: publicUser(user),
      preferences: user.session_id ? store.getProfile(user.session_id) : null,
      trips: threads.map((t) => ({
        title: t.title, destination: t.destination, createdAt: toIso(t.created_at), updatedAt: toIso(t.updated_at),
        messages: store.getMessages(t.id).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content).map((m) => ({ role: m.role, content: m.content, at: toIso(m.created_at) })),
        tripDetails: store.getTrip(t.id),
        plan: store.latestItinerary(t.id) ?? null,
      })),
    };
  },

  /** Delete the account and everything in it: trips, preferences, sign-ins and links. Feedback events are kept without the session. */
  delete(userId: number) {
    db.transaction(() => {
      const sessions = (db.prepare('SELECT session_id FROM sessions WHERE user_id = ?').all(userId) as { session_id: string }[]).map((r) => r.session_id);
      for (const sid of sessions) {
        for (const t of store.listThreads(sid)) store.deleteThread(t.id, sid);
        db.prepare('DELETE FROM profiles WHERE session_id = ?').run(sid);
        db.prepare('UPDATE events SET session_id = NULL WHERE session_id = ?').run(sid);
      }
      db.prepare('UPDATE sessions SET user_id = NULL WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      for (const sid of sessions) db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sid);
    })();
  },
};
