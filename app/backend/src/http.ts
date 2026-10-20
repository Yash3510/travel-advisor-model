// Small HTTP helpers shared by the route modules: JSON bodies and replies, typed errors, and per-IP rate limits.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.js';
import { db } from './db.js';

export type Body = Record<string, unknown>;

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

export function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > config.maxBodyBytes) reject(new HttpError(413, 'body_too_large', 'Request body is too large.'));
      else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Body) : {});
      } catch { reject(new HttpError(400, 'invalid_json', 'Request body must be JSON.')); }
    });
    req.on('error', reject);
  });
}

export const str = (v: unknown) => (typeof v === 'string' ? v : '');

export const clientIp = (req: IncomingMessage) =>
  (config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';

// Fixed-window limiter per IP and bucket: chat (every message costs a model call), sign-in, contact, events. Counters
// live in SQLite, so a restart doesn't reset them; with several instances, share the database or limit at the proxy.
let sweptAt = 0;
export function rateLimited(req: IncomingMessage, bucket = 'chat', perMin = config.chatRateLimitPerMin): boolean {
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  const windowStart = now - (now % 60_000);
  if (now - sweptAt > 60_000) { sweptAt = now; db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(windowStart); }
  const row = db.prepare(`INSERT INTO rate_limits(key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END, window_start = excluded.window_start
    RETURNING count`).get(key, windowStart) as { count: number };
  return row.count > perMin;
}

