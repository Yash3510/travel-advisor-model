// Admin roles change only from the server, never from the site (D-025).
// usage: npm run admin -- grant <email> | revoke <email> | reset-2fa <email> | list
import { db } from '../db.js';

const [cmd, email] = process.argv.slice(2);
const user = email ? db.prepare('SELECT id, email, role FROM users WHERE email = ? COLLATE NOCASE').get(email.trim()) as { id: number; email: string; role: string } | undefined : undefined;
const log = (action: string, target: number) => db.prepare("INSERT INTO admin_audit(admin_id, action, target, ip) VALUES (0, ?, ?, 'server')").run(action, String(target));

if (cmd === 'list') {
  console.table(db.prepare("SELECT id, email, totp_enabled_at AS two_step_since FROM users WHERE role = 'admin'").all());
} else if (!user || !['grant', 'revoke', 'reset-2fa'].includes(cmd)) {
  console.error(user || !email ? 'usage: npm run admin -- grant|revoke|reset-2fa <email> | list' : `no account with email ${email}`);
  process.exit(1);
} else if (cmd === 'grant') {
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  log('role_granted', user.id);
  console.log(`${user.email} is now an admin. They set up two-step sign-in the first time they open /admin.`);
} else {
  // revoking or resetting also ends every two-step check this account has passed
  db.prepare(`UPDATE users SET ${cmd === 'revoke' ? "role = 'user', " : ''}totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ?`).run(user.id);
  db.prepare('UPDATE auth_sessions SET mfa_at = NULL WHERE user_id = ?').run(user.id);
  log(cmd === 'revoke' ? 'role_revoked' : 'mfa_reset', user.id);
  console.log(cmd === 'revoke' ? `${user.email} is no longer an admin.` : `Two-step sign-in reset for ${user.email}; they set it up again at /admin.`);
}
