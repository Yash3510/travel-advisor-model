import path from 'node:path';
import { fileURLToPath } from 'node:url';

// backend/ root, so paths work no matter which directory the server is started from
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Local secrets (MODEL_API_KEY) can live in backend/.env; real env vars win.
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env file */ }

const num = (v: string | undefined, fallback: number) => (v ? Number(v) : fallback);

export const config = {
  port: num(process.env.PORT, 5590),
  host: process.env.HOST ?? '0.0.0.0',
  // Any OpenAI-compatible endpoint: local llama-server (default) or a hosted provider.
  modelUrl: process.env.MODEL_URL ?? process.env.LLAMA_URL ?? 'http://127.0.0.1:8081',
  modelApiKey: process.env.MODEL_API_KEY ?? '',
  model: process.env.MODEL_NAME ?? 'travel-advisor-v2',
  modelTimeoutMs: num(process.env.MODEL_TIMEOUT_MS, 60000),
  // llama-server accepts top_k; set MODEL_TOP_K=0 for providers that reject it
  modelTopK: num(process.env.MODEL_TOP_K, 20),
  dbPath: process.env.DB_PATH ?? path.join(root, 'data', 'threads.db'),
  catalogPath: process.env.CATALOG_PATH ?? path.join(root, 'data', 'catalog.json'),
  // Comma-separated list of frontend origins; "*" allows any (dev only).
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: process.env.TRUST_PROXY === '1',
  chatRateLimitPerMin: num(process.env.CHAT_RATE_LIMIT_PER_MIN, 20),
  maxBodyBytes: 64 * 1024,
  maxMessageChars: 4000,
  serveTestUi: process.env.SERVE_TEST_UI === '1',
  testUiPath: path.join(root, '..', 'frontend', 'index.html'),
  // keep this much of a thread's history (characters) in each model call; 16k-token context per slot
  maxHistoryChars: num(process.env.MAX_HISTORY_CHARS, 30000),
  // SSE comment lines while the model works, so proxies don't drop a quiet connection
  sseHeartbeatMs: num(process.env.SSE_HEARTBEAT_MS, 15000),
  // self-hosted OSRM for road times between stops; empty = labelled straight-line estimates (docs/data-sources.md)
  routingUrl: process.env.ROUTING_URL ?? '',
  routingTimeoutMs: num(process.env.ROUTING_TIMEOUT_MS, 2000),
  logTools: process.env.LOG_TOOLS === '1',
  logRequests: process.env.LOG_REQUESTS !== '0',
  // ── accounts (D-021) ──
  // the frontend's public address, for links in emails (verify, reset)
  appUrl: (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  // Secure cookies need HTTPS: on in production unless COOKIE_SECURE=0
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === '1' : process.env.NODE_ENV === 'production',
  authSessionDays: num(process.env.AUTH_SESSION_DAYS, 30),
  // multiplies the sign-in rate limits (tests raise it)
  authRateScale: num(process.env.AUTH_RATE_SCALE, 1),
  // refuse passwords seen in breaches (Have I Been Pwned range API; only a 5-character hash prefix leaves the server)
  pwnedCheck: process.env.PWNED_CHECK !== '0',
  // Cloudflare Turnstile on sign-up, password reset and the contact form; empty = off
  turnstileSecret: process.env.TURNSTILE_SECRET ?? '',
  // email: Resend when RESEND_API_KEY is set; otherwise messages go to the dev outbox (never in production)
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  mailFrom: process.env.MAIL_FROM ?? 'Takeoff <hello@example.com>',
  // "Continue with Google" is offered only when this is set (OAuth client of type Web application)
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  /** encrypts admins' two-step secrets at rest (D-025); 32+ random characters. Without it the admin panel stays off. */
  adminSecretKey: process.env.ADMIN_SECRET_KEY ?? '',
  /** how long a two-step check lasts on one browser */
  adminMfaHours: num(process.env.ADMIN_MFA_HOURS, 12),
};

export type Config = typeof config;
