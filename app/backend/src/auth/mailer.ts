// Sends account emails through Resend (https://resend.com) when RESEND_API_KEY is set. Without a key the message
// is stored in the dev outbox and logged, so verification and reset can be tried locally; production refuses that.
import { config } from '../config.js';
import { db } from '../db.js';
import { log } from '../log.js';

export interface Mail { to: string; subject: string; text: string; html?: string }

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
    body: JSON.stringify({ from: config.mailFrom, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`email provider ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

/** The newest dev-outbox email to an address (tests and local runs). */
export const lastDevMail = (to: string) =>
  db.prepare('SELECT subject, text FROM outbox WHERE to_email = ? COLLATE NOCASE ORDER BY id DESC LIMIT 1').get(to) as { subject: string; text: string } | undefined;

const sign = 'Takeoff\n(If you did not ask for this, you can ignore this email.)';
const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The site's look in email-safe HTML: warm off-white page, white card, bold wordmark, one black pill button. */
function branded(o: { preview: string; heading: string; body: string; button: string; link: string; note: string }): string {
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light"><title>${esc(o.heading)}</title></head>
<body style="margin:0;padding:0;background:#FAF8F5;font-family:${font};color:#18181b">
<div style="display:none;max-height:0;overflow:hidden">${esc(o.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F5"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">
<tr><td style="padding:0 8px 20px;font-size:20px;font-weight:800;letter-spacing:-0.5px">Takeoff <span style="font-size:10px;font-weight:600;letter-spacing:1.5px;color:#57534e;background:#f5f5f4;border:1px solid #e7e5e4;border-radius:999px;padding:2px 8px;vertical-align:middle">STUDIO</span></td></tr>
<tr><td style="background:#ffffff;border:1px solid #E0DEDC;border-radius:28px;padding:32px">
<h1 style="margin:0 0 12px;font-size:24px;line-height:1.2;font-weight:800;letter-spacing:-0.6px;color:#0c0a09">${esc(o.heading)}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#57534e">${o.body}</p>
<a href="${esc(o.link)}" style="display:inline-block;background:#000000;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 22px;border-radius:999px">${esc(o.button)}</a>
<p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#78716c">${esc(o.note)}<br>Or paste this link into your browser:<br><span style="color:#57534e;word-break:break-all">${esc(o.link)}</span></p>
</td></tr>
<tr><td style="padding:20px 8px 0;font-size:12px;line-height:1.6;color:#a8a29e">If you did not ask for this, you can ignore this email.</td></tr>
</table></td></tr></table></body></html>`;
}

export const verifyMail = (to: string, name: string, link: string): Mail => ({
  to, subject: 'Confirm your email for Takeoff',
  text: `Hi ${name},\n\nConfirm your email address to finish setting up your Takeoff account:\n${link}\n\nThe link works for 24 hours.\n\n${sign}`,
  html: branded({ preview: 'One click to confirm your email.', heading: 'Confirm your email', body: `Hi ${esc(name)}, confirm your email address to finish setting up your Takeoff account. It keeps your trips safe and lets you reset your password.`, button: 'Confirm email', link, note: 'The link works for 24 hours.' }),
});
export const resetMail = (to: string, name: string, link: string): Mail => ({
  to, subject: 'Reset your Takeoff password',
  text: `Hi ${name},\n\nUse this link to choose a new password:\n${link}\n\nThe link works for 1 hour and can be used once.\n\n${sign}`,
  html: branded({ preview: 'Choose a new password for Takeoff.', heading: 'Choose a new password', body: `Hi ${esc(name)}, someone (hopefully you) asked to reset the password for your Takeoff account. Use the button below to choose a new one. You'll be signed out on other devices.`, button: 'Choose a new password', link, note: 'The link works for 1 hour and can be used once.' }),
});
