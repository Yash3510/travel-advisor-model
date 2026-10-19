import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { emptyProfile, type TravelerProfile } from './domain/profile.js';
import { emptyTrip, type TripContext } from './domain/trip.js';
import type { ItineraryDraft } from './domain/itinerary.js';

if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Databases from before tool messages were stored: rebuild `messages` with the wider role check.
const oldMessages = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'messages'").get()
  && !(db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).some((c) => c.name === 'tool_calls');
if (oldMessages) db.exec('ALTER TABLE messages RENAME TO messages_v0; DROP INDEX IF EXISTS idx_messages_thread;');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  title TEXT NOT NULL,
  destination TEXT,
  region_code TEXT,
  stage TEXT NOT NULL DEFAULT 'collecting',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Tool calls and tool results are kept too, so the model can act on offers from earlier turns.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Tool offers and catalog deals shown in a thread; /api/confirm only accepts these.
CREATE TABLE IF NOT EXISTS offers (
  offer_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (offer_id, thread_id)
);
CREATE TABLE IF NOT EXISTS booking_requests (
  booking_ref TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  status TEXT NOT NULL,
  travelers INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (offer_id, thread_id)
);
-- Reusable traveler preferences, per user (the session until accounts exist), and one trip per thread.
CREATE TABLE IF NOT EXISTS profiles (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS trips (
  thread_id INTEGER PRIMARY KEY REFERENCES threads(id),
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Every version of a thread's itinerary; the latest is the current plan.
CREATE TABLE IF NOT EXISTS itineraries (
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (thread_id, version)
);
-- What one customer message changed, so it can be taken back (edit or regenerate): the trip before it and
-- the plan version before it. Keyed by the message's id.
CREATE TABLE IF NOT EXISTS turns (
  user_message_id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  trip_before TEXT,
  itinerary_version_before INTEGER
);
-- Product events from the client (e.g. a thumbs up on a reply) and messages from the contact form.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  name TEXT NOT NULL,
  props TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  topic TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Accounts (D-021). A user owns one chat session (session_id); sessions.user_id marks every session merged into it.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT,
  google_sub TEXT UNIQUE,
  email_verified_at TEXT,
  session_id TEXT REFERENCES sessions(session_id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Signed-in browsers: only a hash of the cookie's token is stored.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One-time links for email verification and password reset (hashed, expiring, single use).
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
-- Development only: emails that would have been sent (no RESEND_API_KEY).
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_threads_session ON threads(session_id);
CREATE INDEX IF NOT EXISTS idx_offers_thread ON offers(thread_id);
`);
// sessions merged into an account (D-021)
if (!(db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some((c) => c.name === 'user_id')) {
  db.exec('ALTER TABLE sessions ADD COLUMN user_id INTEGER REFERENCES users(id)');
}
if (oldMessages) {
  db.exec(`INSERT INTO messages(id, thread_id, role, content, created_at)
           SELECT id, thread_id, role, content, created_at FROM messages_v0; DROP TABLE messages_v0;`);
}

export interface ThreadRow {
  id: number; session_id: string; title: string; destination: string | null;
  region_code: string | null; stage: string; is_active: number;
  created_at: string; updated_at: string;
}
export interface StoredMessage { role: 'user' | 'assistant' | 'tool'; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }
export interface MessageRow {
  id: number; thread_id: number; role: StoredMessage['role']; content: string;
  tool_calls: string | null; tool_call_id: string | null; name: string | null; created_at: string;
}
export interface Offer { offer_id: string; [k: string]: unknown }

/** The user turn /api/confirm records; shared with routes.ts. */
export const CONFIRM_TURN = '(The customer pressed Confirm.)';

const touch = db.prepare("UPDATE threads SET updated_at = datetime('now') WHERE id = ?");

export const store = {
  createSession() {
    const id = randomUUID();
    db.prepare('INSERT INTO sessions(session_id) VALUES (?)').run(id);
    return id;
  },
  sessionExists(sessionId: string) {
    return !!db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(sessionId);
  },
  listThreads(sessionId: string) {
    return db.prepare('SELECT * FROM threads WHERE session_id = ? ORDER BY updated_at DESC, id DESC').all(sessionId) as ThreadRow[];
  },
  createThread(sessionId: string, title: string) {
    const info = db.prepare('INSERT INTO threads(session_id, title) VALUES (?, ?)').run(sessionId, title);
    return Number(info.lastInsertRowid);
  },
  /** A thread only if it belongs to this session: thread ids are sequential, so never trust one alone. */
  getThread(id: number, sessionId: string) {
    return db.prepare('SELECT * FROM threads WHERE id = ? AND session_id = ?').get(id, sessionId) as ThreadRow | undefined;
  },
  /** Delete a thread and everything in it; false when it is not this session's thread. */
  deleteThread(id: number, sessionId: string): boolean {
    return db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM threads WHERE id = ? AND session_id = ?').get(id, sessionId)) return false;
      for (const table of ['messages', 'offers', 'booking_requests', 'trips', 'itineraries', 'turns']) {
        db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(id);
      }
      db.prepare('DELETE FROM threads WHERE id = ?').run(id);
      return true;
    })();
  },
  /** Rename; false when it is not this session's thread. */
  renameThread(id: number, sessionId: string, title: string): boolean {
    return db.prepare('UPDATE threads SET title = ? WHERE id = ? AND session_id = ?').run(title, id, sessionId).changes > 0;
  },
  updateThread(id: number, fields: { destination: string; region_code: string; stage: string }) {
    db.prepare("UPDATE threads SET destination = @destination, region_code = @region_code, stage = @stage, updated_at = datetime('now') WHERE id = @id")
      .run({ ...fields, id });
  },
  appendMessage(threadId: number, m: StoredMessage): number {
    const info = db.prepare('INSERT INTO messages(thread_id, role, content, tool_calls, tool_call_id, name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(threadId, m.role, m.content, m.tool_calls ? JSON.stringify(m.tool_calls) : null, m.tool_call_id ?? null, m.name ?? null);
    touch.run(threadId);
    return Number(info.lastInsertRowid);
  },
  /** Remember what a customer message is about to change (see `turns`). */
  saveTurn(threadId: number, userMessageId: number, tripBefore: TripContext | null, itineraryVersionBefore: number | null) {
    db.prepare('INSERT OR REPLACE INTO turns(user_message_id, thread_id, trip_before, itinerary_version_before) VALUES (?, ?, ?, ?)')
      .run(userMessageId, threadId, tripBefore ? JSON.stringify(tripBefore) : null, itineraryVersionBefore);
  },
  /**
   * Take back the newest customer message and everything after it, and restore the trip and plan from before it.
   * Returns the message text, or why it can't: 'empty' (nothing to take back), 'booking' (a booking request came after it).
   */
  rewind(threadId: number): { text: string } | { error: 'empty' | 'booking' } {
    return db.transaction(() => {
      const last = db.prepare("SELECT id, content FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(threadId) as { id: number; content: string } | undefined;
      if (!last) return { error: 'empty' as const };
      // the Confirm button's turn is a record of a supplier request, not something to rewrite
      if (last.content === CONFIRM_TURN || db.prepare("SELECT 1 FROM messages WHERE thread_id = ? AND id > ? AND tool_call_id = 'confirm'").get(threadId, last.id)) return { error: 'booking' as const };
      const turn = db.prepare('SELECT trip_before, itinerary_version_before FROM turns WHERE user_message_id = ?').get(last.id) as { trip_before: string | null; itinerary_version_before: number | null } | undefined;
      db.prepare('DELETE FROM messages WHERE thread_id = ? AND id >= ?').run(threadId, last.id);
      if (turn) {
        db.prepare('DELETE FROM itineraries WHERE thread_id = ? AND version > ?').run(threadId, turn.itinerary_version_before ?? 0);
        if (turn.trip_before) db.prepare('UPDATE trips SET data = ? WHERE thread_id = ?').run(turn.trip_before, threadId);
        else db.prepare('DELETE FROM trips WHERE thread_id = ?').run(threadId);
      }
      db.prepare('DELETE FROM turns WHERE thread_id = ? AND user_message_id >= ?').run(threadId, last.id);
      // with every message taken back the thread starts over: the destination (and its deals) can be detected again
      if (!db.prepare("SELECT 1 FROM messages WHERE thread_id = ? AND role = 'user'").get(threadId)) {
        db.prepare("UPDATE threads SET destination = NULL, region_code = NULL, stage = 'collecting' WHERE id = ?").run(threadId);
      }
      touch.run(threadId);
      return { text: last.content };
    })();
  },
  getMessages(threadId: number): MessageRow[] {
    return db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id').all(threadId) as MessageRow[];
  },
  saveOffers(threadId: number, offers: Offer[]) {
    const ins = db.prepare('INSERT OR IGNORE INTO offers(offer_id, thread_id, payload) VALUES (?, ?, ?)');
    for (const o of offers) ins.run(o.offer_id, threadId, JSON.stringify(o));
  },
  getOffer(offerId: string, threadId: number): Offer | undefined {
    const row = db.prepare('SELECT payload FROM offers WHERE offer_id = ? AND thread_id = ?').get(offerId, threadId) as { payload: string } | undefined;
    return row && JSON.parse(row.payload);
  },
  findBooking(offerId: string, threadId: number) {
    return db.prepare('SELECT booking_ref, status FROM booking_requests WHERE offer_id = ? AND thread_id = ?').get(offerId, threadId) as
      { booking_ref: string; status: string } | undefined;
  },
  saveBooking(ref: string, offerId: string, threadId: number, status: string, travelers: number) {
    db.prepare('INSERT INTO booking_requests(booking_ref, offer_id, thread_id, status, travelers) VALUES (?, ?, ?, ?, ?)')
      .run(ref, offerId, threadId, status, travelers);
  },
  /** A booking request by reference, only within the asking session's threads. */
  findBookingByRef(ref: string, sessionId: string) {
    const row = db.prepare(`SELECT b.booking_ref, b.status, b.travelers, b.created_at, o.payload FROM booking_requests b
      JOIN threads t ON t.id = b.thread_id JOIN offers o ON o.offer_id = b.offer_id AND o.thread_id = b.thread_id
      WHERE b.booking_ref = ? AND t.session_id = ?`).get(ref, sessionId) as
      { booking_ref: string; status: string; travelers: number; created_at: string; payload: string } | undefined;
    return row && { ...row, offer: JSON.parse(row.payload) as Offer };
  },
  getProfile(sessionId: string): TravelerProfile {
    const row = db.prepare('SELECT data FROM profiles WHERE session_id = ?').get(sessionId) as { data: string } | undefined;
    return row ? { ...emptyProfile(), ...(JSON.parse(row.data) as TravelerProfile) } : emptyProfile();
  },
  saveProfile(sessionId: string, profile: TravelerProfile) {
    db.prepare("INSERT INTO profiles(session_id, data) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')")
      .run(sessionId, JSON.stringify(profile));
  },
  resetProfile(sessionId: string) {
    db.prepare('DELETE FROM profiles WHERE session_id = ?').run(sessionId);
  },
  getTrip(threadId: number): TripContext {
    const row = db.prepare('SELECT data FROM trips WHERE thread_id = ?').get(threadId) as { data: string } | undefined;
    return row ? { ...emptyTrip(), ...(JSON.parse(row.data) as TripContext) } : emptyTrip();
  },
  saveTrip(threadId: number, trip: TripContext) {
    db.prepare("INSERT INTO trips(thread_id, data) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')")
      .run(threadId, JSON.stringify(trip));
  },
  saveItinerary(threadId: number, draft: ItineraryDraft) {
    db.prepare('INSERT OR REPLACE INTO itineraries(thread_id, version, data) VALUES (?, ?, ?)').run(threadId, draft.version, JSON.stringify(draft));
  },
  latestItinerary(threadId: number): ItineraryDraft | undefined {
    const row = db.prepare('SELECT data FROM itineraries WHERE thread_id = ? ORDER BY version DESC LIMIT 1').get(threadId) as { data: string } | undefined;
    return row && (JSON.parse(row.data) as ItineraryDraft);
  },
  saveEvent(sessionId: string | null, name: string, props: string) {
    db.prepare('INSERT INTO events(session_id, name, props) VALUES (?, ?, ?)').run(sessionId, name, props);
  },
  listEvents(name: string) {
    return db.prepare('SELECT session_id, name, props, created_at FROM events WHERE name = ? ORDER BY id').all(name) as { session_id: string | null; name: string; props: string; created_at: string }[];
  },
  saveContact(m: { name: string; email: string; topic: string; message: string }): number {
    return Number(db.prepare('INSERT INTO contact_messages(name, email, topic, message) VALUES (@name, @email, @topic, @message)').run(m).lastInsertRowid);
  },
  listContacts() {
    return db.prepare('SELECT * FROM contact_messages ORDER BY id').all() as { id: number; name: string; email: string; topic: string; message: string; created_at: string }[];
  },
  /** Run several writes atomically. */
  tx<T>(fn: () => T): T { return db.transaction(fn)(); },
  close() { db.close(); },
};

export type Store = typeof store;
