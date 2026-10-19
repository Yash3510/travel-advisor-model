// Accounts (D-021): users, signed-in browsers, one-time email links, and the chat session each user owns.
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { db, store } from '../db.js';

export interface UserRow {
  id: number; email: string; name: string; password_hash: string | null; google_sub: string | null;
  email_verified_at: string | null; session_id: string | null; created_at: string;
}

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const sqlTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const toIso = (sqliteUtc: string) => new Date(sqliteUtc.replace(' ', 'T') + 'Z').toISOString();

/** What the client may see about a user. */
export const publicUser = (u: UserRow) => ({
  id: u.id, name: u.name, email: u.email, emailVerified: !!u.email_verified_at,
  hasPassword: !!u.password_hash, google: !!u.google_sub, createdAt: toIso(u.created_at),
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

  // ── signed-in browsers ──
  /** A new sign-in: returns the cookie's token (only its hash is stored). */
  startSession(userId: number): string {
    const token = newToken();
    db.prepare("DELETE FROM auth_sessions WHERE expires_at < datetime('now')").run();
    db.prepare('INSERT INTO auth_sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), userId, sqlTime(Date.now() + config.authSessionDays * 86_400_000));
    return token;
  },
  userForToken(token: string | undefined): UserRow | undefined {
    if (!token) return undefined;
    const row = db.prepare("SELECT user_id FROM auth_sessions WHERE token_hash = ? AND expires_at > datetime('now')").get(sha256(token)) as { user_id: number } | undefined;
    return row && accounts.byId(row.user_id);
  },
  endSession: (token: string) => db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token)),
  /** Sign out everywhere, except the browser holding `keep`. */
  endOtherSessions: (userId: number, keep?: string) =>
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?').run(userId, keep ? sha256(keep) : ''),

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
