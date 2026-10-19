// Sends account emails through Resend (https://resend.com) when RESEND_API_KEY is set. Without a key the message
// is stored in the dev outbox and logged, so verification and reset can be tried locally; production refuses that.
import { config } from '../config.js';
import { db } from '../db.js';
import { log } from '../log.js';

export interface Mail { to: string; subject: string; text: string }

export async function sendMail(m: Mail): Promise<void> {
  if (!config.resendApiKey) {
    if (process.env.NODE_ENV === 'production') throw new Error('RESEND_API_KEY is not set: account emails cannot be sent');
    db.prepare('INSERT INTO outbox(to_email, subject, text) VALUES (?, ?, ?)').run(m.to, m.subject, m.text);
    log('info', 'dev outbox: email not sent (no RESEND_API_KEY)', { to: m.to, subject: m.subject });
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.mailFrom, to: [m.to], subject: m.subject, text: m.text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`email provider ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

/** The newest dev-outbox email to an address (tests and local runs). */
export const lastDevMail = (to: string) =>
  db.prepare('SELECT subject, text FROM outbox WHERE to_email = ? COLLATE NOCASE ORDER BY id DESC LIMIT 1').get(to) as { subject: string; text: string } | undefined;

const sign = 'Takeoff\n(If you did not ask for this, you can ignore this email.)';
export const verifyMail = (to: string, name: string, link: string): Mail => ({
  to, subject: 'Confirm your email for Takeoff',
  text: `Hi ${name},\n\nConfirm your email address to finish setting up your Takeoff account:\n${link}\n\nThe link works for 24 hours.\n\n${sign}`,
});
export const resetMail = (to: string, name: string, link: string): Mail => ({
  to, subject: 'Reset your Takeoff password',
  text: `Hi ${name},\n\nUse this link to choose a new password:\n${link}\n\nThe link works for 1 hour and can be used once.\n\n${sign}`,
});
