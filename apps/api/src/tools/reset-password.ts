/**
 * Offline account recovery, run by an administrator on the server (Reset-Password.ps1 wraps it):
 *   HEXYRN_NEW_PASSWORD=... node reset-password.js --email owner@example.com
 * For the case where the Owner is locked out and email (SMTP) is not set up. It needs the database settings the
 * service itself uses, so only someone who can read the protected settings file can run it. The new password comes
 * from the environment, never the command line (which other users could see). Existing sessions are revoked and the
 * account's lock-out counter is cleared. Two-factor sign-in is left as it is (use the Users page to reset it).
 */
import { Pool } from 'pg';
import './../config/load-env-file';
import { hashPassword } from '../security/passwords';

export async function resetPassword(
  pool: Pool,
  email: string,
  newPassword: string,
): Promise<boolean> {
  if (newPassword.length < 12) throw new Error('The new password must be at least 12 characters.');
  const hash = await hashPassword(newPassword);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE user_accounts SET password_hash = $1, failed_login_count = 0, locked_until = NULL, updated_at = now()
        WHERE lower(email) = lower($2) RETURNING id`,
      [hash, email],
    );
    if (updated.rowCount !== 1) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `UPDATE sessions SET revoked_at = now() WHERE user_account_id = $1 AND revoked_at IS NULL`,
      [updated.rows[0].id],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--email');
  const email = i > 0 ? process.argv[i + 1] : '';
  const password = process.env.HEXYRN_NEW_PASSWORD ?? '';
  const url = process.env.BACKUP_DATABASE_URL; // the role that can see every organisation's rows
  if (!email || !url)
    throw new Error(
      'usage: --email <address>, with HEXYRN_NEW_PASSWORD and BACKUP_DATABASE_URL set',
    );
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const ok = await resetPassword(pool, email, password);
    console.log(
      ok
        ? `Password changed for ${email}. All their sessions were signed out.`
        : `No account found for ${email}.`,
    );
    process.exitCode = ok ? 0 : 2;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
