// Cloudflare Turnstile: a bot check on sign-up, password reset and the contact form. Off until TURNSTILE_SECRET is set.
import type { IncomingMessage } from 'node:http';
import { config } from '../config.js';
import { clientIp, HttpError, str } from '../http.js';
import { log } from '../log.js';

export async function checkHuman(req: IncomingMessage, token: unknown): Promise<void> {
  if (!config.turnstileSecret) return;
  let ok = false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: config.turnstileSecret, response: str(token), remoteip: clientIp(req) }),
      signal: AbortSignal.timeout(5000),
    });
    ok = !!((await res.json()) as { success?: boolean }).success;
  } catch (err) {
    log('warn', 'turnstile check failed', { error: (err as Error).message });
  }
  if (!ok) throw new HttpError(400, 'bot_check', 'Please complete the check that you are not a robot, then try again.');
}
