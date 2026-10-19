// Small HTTP helpers shared by the route modules: JSON bodies and replies, typed errors, and per-IP rate limits.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.js';

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

// Fixed-window limiter per IP and bucket: chat (every message costs a model call), contact, events. Per process: use
// one instance or put a shared limiter in the reverse proxy when scaling out.
const hits = new Map<string, { start: number; count: number }>();
export function rateLimited(req: IncomingMessage, bucket = 'chat', perMin = config.chatRateLimitPerMin): boolean {
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.start >= 60_000) hits.delete(k);
  const h = hits.get(key);
  if (!h || now - h.start >= 60_000) { hits.set(key, { start: now, count: 1 }); return false; }
  return ++h.count > perMin;
}

