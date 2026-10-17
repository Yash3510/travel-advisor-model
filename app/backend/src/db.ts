import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
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
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_threads_session ON threads(session_id);
CREATE INDEX IF NOT EXISTS idx_offers_thread ON offers(thread_id);
`);
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
  updateThread(id: number, fields: { destination: string; region_code: string; stage: string }) {
    db.prepare("UPDATE threads SET destination = @destination, region_code = @region_code, stage = @stage, updated_at = datetime('now') WHERE id = @id")
      .run({ ...fields, id });
  },
  appendMessage(threadId: number, m: StoredMessage) {
    db.prepare('INSERT INTO messages(thread_id, role, content, tool_calls, tool_call_id, name) VALUES (?, ?, ?, ?, ?, ?)')
      .run(threadId, m.role, m.content, m.tool_calls ? JSON.stringify(m.tool_calls) : null, m.tool_call_id ?? null, m.name ?? null);
    touch.run(threadId);
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
  /** Run several writes atomically. */
  tx<T>(fn: () => T): T { return db.transaction(fn)(); },
  close() { db.close(); },
};

export type Store = typeof store;
