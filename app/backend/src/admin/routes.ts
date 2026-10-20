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

export const BOOKING_STATUSES = ['PENDING_SUPPLIER_CONFIRMATION', 'IN_PROGRESS', 'CONFIRMED', 'CANCELLED'] as const;
const toIso = (t: string | null) => (t ? new Date(t.replace(' ', 'T') + 'Z').toISOString() : null);

function audit(req: IncomingMessage, admin: UserRow, action: string, target?: string, detail?: Record<string, unknown>) {
  db.prepare('INSERT INTO admin_audit(admin_id, action, target, detail, ip) VALUES (?, ?, ?, ?, ?)')
    .run(admin.id, action, target ?? null, detail ? JSON.stringify(detail) : null, clientIp(req));
}

const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
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
