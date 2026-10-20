// Admin panel API (D-025). Every route needs: a signed-in account with role 'admin' (anyone else gets 404, so the
// panel's existence isn't advertised), and a two-step code on this browser within ADMIN_MFA_HOURS. Every view of
// personal data and every change is written to admin_audit.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { accounts, type UserRow } from '../auth/accounts.js';
import { cookieToken, currentUser } from '../auth/routes.js';
import { matchStep, newSecret, otpauthUri, seal, unseal } from '../auth/totp.js';
import { config } from '../config.js';
import { db } from '../db.js';
import { clientIp, HttpError, json, rateLimited, readBody, str } from '../http.js';
import { sendMail, teamReplyMail } from '../auth/mailer.js';

export const BOOKING_STATUSES = ['PENDING_SUPPLIER_CONFIRMATION', 'IN_PROGRESS', 'CONFIRMED', 'CANCELLED'] as const;
const toIso = (t: string | null) => (t ? new Date(t.replace(' ', 'T') + 'Z').toISOString() : null);

function audit(req: IncomingMessage, admin: UserRow, action: string, target?: string, detail?: Record<string, unknown>) {
  db.prepare('INSERT INTO admin_audit(admin_id, action, target, detail, ip) VALUES (?, ?, ?, ?, ?)')
    .run(admin.id, action, target ?? null, detail ? JSON.stringify(detail) : null, clientIp(req));
}

/** Personal details hidden in what admins read: emails, phone numbers, long digit runs. */
const mask = (t: string) => t.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').replace(/(\+?\d[\d\s-]{8,}\d)/g, '[number]');
const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
/** Counts per day (UTC) for the last `days` days, oldest first; days with nothing are 0, not missing. */
function daily(days: number) {
  const per = (sql: string) => new Map((db.prepare(sql).all(`-${days - 1} days`) as { d: string; n: number }[]).map((r) => [r.d, r.n]));
  const signups = per("SELECT date(created_at) d, COUNT(*) n FROM users WHERE date(created_at) >= date('now', ?) GROUP BY d");
  const trips = per("SELECT date(created_at) d, COUNT(*) n FROM threads WHERE date(created_at) >= date('now', ?) GROUP BY d");
  const messages = per("SELECT date(created_at) d, COUNT(*) n FROM messages WHERE role = 'user' AND date(created_at) >= date('now', ?) GROUP BY d");
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { date: d, signups: signups.get(d) ?? 0, trips: trips.get(d) ?? 0, messages: messages.get(d) ?? 0 };
  });
}
const secretOf = (u: UserRow) => (u.totp_secret ? unseal(u.totp_secret, config.adminSecretKey) : null);

export async function handleAdmin(req: IncomingMessage, res: ServerResponse, pathname: string, search: URLSearchParams): Promise<boolean> {
  if (!pathname.startsWith('/api/admin/')) return false;
  res.setHeader('Cache-Control', 'no-store');
  const method = req.method ?? 'GET';
  const origin = req.headers.origin;
  if (method !== 'GET' && origin && !config.allowedOrigins.includes('*') && !config.allowedOrigins.includes(origin)) {
    throw new HttpError(403, 'forbidden_origin', 'Requests must come from the Takeoff site.');
  }
  const admin = currentUser(req);
  if (!admin || admin.role !== 'admin') throw new HttpError(404, 'not_found', 'Not found.');
  if (!config.adminSecretKey) throw new HttpError(503, 'admin_off', 'The admin panel is off: set ADMIN_SECRET_KEY on the server.');
  const token = cookieToken(req)!;
  const route = `${method} ${pathname}`;

  // ── two-step check ──
  if (route === 'GET /api/admin/mfa') {
    json(res, 200, { enrolled: !!admin.totp_enabled_at, verified: accounts.mfaFresh(token, config.adminMfaHours) });
    return true;
  }
  if (route === 'POST /api/admin/mfa/setup') {
    if (admin.totp_enabled_at) throw new HttpError(409, 'mfa_enrolled', 'Two-step sign-in is already set up for this account.');
    // a new key each time until the first code confirms it
    const secret = newSecret();
    db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = NULL WHERE id = ?').run(seal(secret, config.adminSecretKey), admin.id);
    audit(req, admin, 'mfa_setup_started');
    json(res, 200, { secret, uri: otpauthUri(secret, admin.email) });
    return true;
  }
  if (route === 'POST /api/admin/mfa/verify') {
    if (rateLimited(req, `admin-mfa:${admin.id}`, 5)) throw new HttpError(429, 'rate_limited', 'Too many tries. Please wait a minute.');
    const code = str((await readBody(req)).code).replace(/\s/g, '').slice(0, 12);
    const secret = secretOf(admin);
    if (!secret) throw new HttpError(409, 'mfa_not_set_up', 'Set up two-step sign-in first.');
    const step = matchStep(secret, code, Date.now(), admin.totp_last_step ?? -1);
    if (step === null) { audit(req, admin, 'mfa_failed'); throw new HttpError(401, 'invalid_code', 'That code is not right. Use the newest code from your app.'); }
    db.prepare("UPDATE users SET totp_last_step = ?, totp_enabled_at = COALESCE(totp_enabled_at, datetime('now')) WHERE id = ?").run(step, admin.id);
    accounts.markMfa(token);
    audit(req, admin, admin.totp_enabled_at ? 'mfa_verified' : 'mfa_enrolled');
    json(res, 200, { ok: true });
    return true;
  }
  if (!admin.totp_enabled_at || !accounts.mfaFresh(token, config.adminMfaHours)) {
    throw new HttpError(403, 'mfa_required', 'Enter the code from your authenticator app to continue.');
  }

  // ── overview ──
  if (route === 'GET /api/admin/overview') {
    json(res, 200, {
      users: n('SELECT COUNT(*) n FROM users'),
      usersNew7d: n("SELECT COUNT(*) n FROM users WHERE created_at > datetime('now', '-7 days')"),
      threads7d: n("SELECT COUNT(*) n FROM threads WHERE created_at > datetime('now', '-7 days')"),
      messages7d: n("SELECT COUNT(*) n FROM messages WHERE role = 'user' AND created_at > datetime('now', '-7 days')"),
      bookingsOpen: n("SELECT COUNT(*) n FROM booking_requests WHERE status IN ('PENDING_SUPPLIER_CONFIRMATION', 'IN_PROGRESS')"),
      messagesOpen: n('SELECT COUNT(*) n FROM contact_messages WHERE handled_at IS NULL'),
      sharesActive: n('SELECT COUNT(*) n FROM shares'),
      feedbackDown: n("SELECT COUNT(*) n FROM feedback WHERE rating = 'down' AND training_at IS NULL"),
      flags7d: n("SELECT COUNT(*) n FROM events WHERE name = 'reply_flagged' AND created_at > datetime('now', '-7 days')"),
      daily: daily(14),
    });
    return true;
  }

  // ── booking requests ──
  if (route === 'GET /api/admin/bookings') {
    const rows = db.prepare(`SELECT b.booking_ref, b.status, b.travelers, b.created_at, b.updated_at, b.admin_note, b.thread_id, o.payload,
        t.destination, u.email, u.name
      FROM booking_requests b JOIN threads t ON t.id = b.thread_id
      LEFT JOIN offers o ON o.offer_id = b.offer_id AND o.thread_id = b.thread_id
      LEFT JOIN sessions s ON s.session_id = t.session_id LEFT JOIN users u ON u.id = s.user_id
      ORDER BY b.created_at DESC LIMIT 200`).all() as Record<string, string | number | null>[];
    audit(req, admin, 'view_bookings', undefined, { count: rows.length });
    json(res, 200, { bookings: rows.map((r) => ({
      ref: r.booking_ref, status: r.status, travelers: r.travelers, destination: r.destination, threadId: r.thread_id,
      createdAt: toIso(r.created_at as string), updatedAt: toIso(r.updated_at as string | null), note: r.admin_note ?? '',
      customer: r.email ? { name: r.name, email: r.email } : null, offer: r.payload ? JSON.parse(r.payload as string) : null,
    })) });
    return true;
  }
  const booking = /^PATCH \/api\/admin\/bookings\/([\w-]{3,64})$/.exec(route);
  if (booking) {
    const body = await readBody(req);
    const status = body.status === undefined ? undefined : String(body.status);
    if (status !== undefined && !(BOOKING_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, 'invalid_status', 'Unknown status.');
    const note = body.note === undefined ? undefined : str(body.note).trim().slice(0, 2000);
    const r = db.prepare(`UPDATE booking_requests SET status = COALESCE(?, status), admin_note = COALESCE(?, admin_note), updated_at = datetime('now')
      WHERE booking_ref = ?`).run(status ?? null, note ?? null, booking[1]);
    if (!r.changes) throw new HttpError(404, 'booking_not_found', 'No booking request with that reference.');
    audit(req, admin, 'update_booking', booking[1], { status, note: note === undefined ? undefined : '(changed)' });
    json(res, 200, { ok: true });
    return true;
  }

  // ── contact messages ──
  if (route === 'GET /api/admin/messages') {
    const rows = db.prepare('SELECT * FROM contact_messages ORDER BY handled_at IS NOT NULL, id DESC LIMIT 200').all() as Record<string, string | number | null>[];
    audit(req, admin, 'view_messages', undefined, { count: rows.length });
    json(res, 200, { messages: rows.map((m) => ({ id: m.id, name: m.name, email: m.email, topic: m.topic, message: m.message,
      createdAt: toIso(m.created_at as string), handledAt: toIso(m.handled_at as string | null) })) });
    return true;
  }
  const message = /^PATCH \/api\/admin\/messages\/(\d+)$/.exec(route);
  if (message) {
    const handled = (await readBody(req)).handled === true;
    const r = db.prepare(`UPDATE contact_messages SET handled_at = ${handled ? "datetime('now')" : 'NULL'} WHERE id = ?`).run(Number(message[1]));
    if (!r.changes) throw new HttpError(404, 'message_not_found', 'No such message.');
    audit(req, admin, handled ? 'message_handled' : 'message_reopened', message[1]);
    json(res, 200, { ok: true });
    return true;
  }

  // ── users ──
  if (route === 'GET /api/admin/users') {
    const q = (search.get('q') ?? '').trim().slice(0, 100);
    const rows = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM threads t JOIN sessions s ON s.session_id = t.session_id WHERE s.user_id = u.id) AS threads
      FROM users u WHERE (? = '' OR u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\') ORDER BY u.id DESC LIMIT 100`)
      .all(q, `%${q.replace(/[\\%_]/g, '\\$&')}%`, `%${q.replace(/[\\%_]/g, '\\$&')}%`) as (UserRow & { threads: number })[];
    audit(req, admin, 'view_users', undefined, { q: q || undefined, count: rows.length });
    json(res, 200, { users: rows.map((u) => ({ id: u.id, name: u.name, email: u.email, emailVerified: !!u.email_verified_at, google: !!u.google_sub,
      admin: u.role === 'admin', disabled: !!u.disabled_at, threads: u.threads, createdAt: toIso(u.created_at) })) });
    return true;
  }
  const toggle = /^POST \/api\/admin\/users\/(\d+)\/(disable|enable)$/.exec(route);
  if (toggle) {
    const target = accounts.byId(Number(toggle[1]));
    if (!target) throw new HttpError(404, 'user_not_found', 'No such user.');
    if (target.role === 'admin') throw new HttpError(400, 'cannot_disable_admin', 'Admins can only be changed from the server.');
    const off = toggle[2] === 'disable';
    db.prepare(`UPDATE users SET disabled_at = ${off ? "datetime('now')" : 'NULL'} WHERE id = ?`).run(target.id);
    if (off) db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(target.id);
    audit(req, admin, off ? 'user_disabled' : 'user_enabled', String(target.id));
    json(res, 200, { ok: true });
    return true;
  }

  // ── feedback and the training queue (D-026) ──
  if (route === 'GET /api/admin/feedback') {
    const rows = db.prepare(`SELECT f.*, m.content AS reply, t.destination,
        (SELECT u.content FROM messages u WHERE u.thread_id = f.thread_id AND u.role = 'user' AND u.id < f.message_id ORDER BY u.id DESC LIMIT 1) AS asked
      FROM feedback f JOIN messages m ON m.id = f.message_id JOIN threads t ON t.id = f.thread_id
      ORDER BY f.rating = 'up', f.updated_at DESC LIMIT 200`).all() as Record<string, string | number | null>[];
    audit(req, admin, 'view_feedback', undefined, { count: rows.length });
    json(res, 200, { feedback: rows.map((f) => ({ messageId: f.message_id, threadId: f.thread_id, rating: f.rating, reason: f.reason, destination: f.destination,
      asked: f.asked ? mask(String(f.asked)) : null, reply: mask(String(f.reply)), training: !!f.training_at, at: toIso(f.updated_at as string) })) });
    return true;
  }
  const queue = /^PATCH \/api\/admin\/feedback\/(\d+)$/.exec(route);
  if (queue) {
    const on = (await readBody(req)).training === true;
    const r = db.prepare(`UPDATE feedback SET training_at = ${on ? "datetime('now')" : 'NULL'} WHERE message_id = ?`).run(Number(queue[1]));
    if (!r.changes) throw new HttpError(404, 'feedback_not_found', 'No such rating.');
    audit(req, admin, on ? 'training_added' : 'training_removed', queue[1]);
    json(res, 200, { ok: true });
    return true;
  }
  if (route === 'GET /api/admin/training-export') {
    // one JSON line per queued reply: the conversation up to it (personal details masked), the rating and the reason
    const rows = db.prepare('SELECT * FROM feedback WHERE training_at IS NOT NULL ORDER BY training_at').all() as { message_id: number; thread_id: number; rating: string; reason: string | null }[];
    const lines = rows.map((f) => JSON.stringify({
      thread: f.thread_id, message: f.message_id, rating: f.rating, reason: f.reason,
      messages: (db.prepare("SELECT role, content FROM messages WHERE thread_id = ? AND id <= ? AND role IN ('user','assistant') AND content != '' ORDER BY id").all(f.thread_id, f.message_id) as { role: string; content: string }[])
        .map((m) => ({ role: m.role, content: mask(m.content) })),
    }));
    audit(req, admin, 'training_exported', undefined, { count: rows.length });
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': `attachment; filename="takeoff-training-${new Date().toISOString().slice(0, 10)}.jsonl"` });
    res.end(lines.join('\n') + (lines.length ? '\n' : ''));
    return true;
  }

  // ── flagged replies: where the checks corrected the model ──
  if (route === 'GET /api/admin/flags') {
    const rows = db.prepare("SELECT id, props, created_at FROM events WHERE name = 'reply_flagged' ORDER BY id DESC LIMIT 200").all() as { id: number; props: string; created_at: string }[];
    audit(req, admin, 'view_flags', undefined, { count: rows.length });
    json(res, 200, { flags: rows.map((r) => {
      const p = JSON.parse(r.props) as { threadId: number; messageId: number; kind: string; model: string };
      const shown = db.prepare('SELECT content FROM messages WHERE id = ?').get(p.messageId) as { content: string } | undefined;
      return { id: r.id, threadId: p.threadId, messageId: p.messageId, kind: p.kind, model: mask(p.model), shown: shown ? mask(shown.content) : null, at: toIso(r.created_at) };
    }) });
    return true;
  }

  // ── one conversation, read-only, personal details masked ──
  const convo = /^GET \/api\/admin\/threads\/(\d+)$/.exec(route);
  if (convo) {
    const t = db.prepare(`SELECT t.id, t.title, t.destination, t.created_at, u.name, u.email FROM threads t
      LEFT JOIN sessions s ON s.session_id = t.session_id LEFT JOIN users u ON u.id = s.user_id WHERE t.id = ?`).get(Number(convo[1])) as Record<string, string | number | null> | undefined;
    if (!t) throw new HttpError(404, 'thread_not_found', 'No such conversation.');
    const rated = new Map((db.prepare('SELECT message_id, rating, reason FROM feedback WHERE thread_id = ?').all(t.id) as { message_id: number; rating: string; reason: string | null }[]).map((f) => [f.message_id, f]));
    audit(req, admin, 'view_conversation', String(t.id));
    json(res, 200, {
      id: t.id, title: mask(String(t.title)), destination: t.destination, createdAt: toIso(t.created_at as string), account: !!t.email,
      messages: (db.prepare("SELECT id, role, content, created_at FROM messages WHERE thread_id = ? AND role IN ('user','assistant') AND content != '' ORDER BY id").all(t.id) as { id: number; role: string; content: string; created_at: string }[])
        .map((m) => ({ id: m.id, role: m.role, content: mask(m.content), at: toIso(m.created_at), feedback: rated.get(m.id) ? { rating: rated.get(m.id)!.rating, reason: rated.get(m.id)!.reason } : null })),
    });
    return true;
  }

  // ── email a customer: a contact message's sender or a booking's account holder ──
  if (route === 'POST /api/admin/email') {
    if (rateLimited(req, `admin-email:${admin.id}`, 10)) throw new HttpError(429, 'rate_limited', 'Too many emails. Please wait a minute.');
    const body = await readBody(req);
    const subject = str(body.subject).trim().slice(0, 150);
    const text = str(body.body).trim().slice(0, 5000);
    if (!subject || text.length < 2) throw new HttpError(400, 'invalid_email_body', 'Write a subject and a message.');
    let to: { name: string; email: string } | undefined;
    if (body.kind === 'message') {
      to = db.prepare('SELECT name, email FROM contact_messages WHERE id = ?').get(Number(body.id)) as typeof to;
    } else if (body.kind === 'booking') {
      to = db.prepare(`SELECT u.name, u.email FROM booking_requests b JOIN threads t ON t.id = b.thread_id JOIN sessions s ON s.session_id = t.session_id
        JOIN users u ON u.id = s.user_id WHERE b.booking_ref = ?`).get(str(body.id)) as typeof to;
    }
    if (!to) throw new HttpError(404, 'recipient_not_found', 'There is no email address for this.');
    try { await sendMail(teamReplyMail(to.email, to.name.split(' ')[0], subject, text)); } catch (err) {
      throw new HttpError(502, 'email_failed', `The email could not be sent: ${(err as Error).message}`);
    }
    if (body.kind === 'message') db.prepare("UPDATE contact_messages SET handled_at = COALESCE(handled_at, datetime('now')) WHERE id = ?").run(Number(body.id));
    audit(req, admin, 'email_sent', `${body.kind}:${String(body.id)}`, { subject });
    json(res, 200, { ok: true });
    return true;
  }

  // ── audit log ──
  if (route === 'GET /api/admin/audit') {
    const rows = db.prepare(`SELECT a.*, u.email AS admin_email FROM admin_audit a LEFT JOIN users u ON u.id = a.admin_id
      ORDER BY a.id DESC LIMIT 200`).all() as Record<string, string | number | null>[];
    json(res, 200, { entries: rows.map((a) => ({ id: a.id, admin: a.admin_email, action: a.action, target: a.target,
      detail: a.detail ? JSON.parse(a.detail as string) : null, ip: a.ip, at: toIso(a.created_at as string) })) });
    return true;
  }

  throw new HttpError(404, 'not_found', 'Not found.');
}
