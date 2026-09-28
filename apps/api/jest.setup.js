// Loads .env for local test runs (test DB URL etc). Silently no-ops if dotenv isn't present.
try {
  require('dotenv').config();
} catch {
  // dotenv not installed - fine, environment variables are expected to already be set (CI).
}

// Test-only defaults so the suite runs from a fresh checkout without a
// hand-built .env. Applied ONLY when the variable is unset; these fixed,
// publicly-committed values must never be used outside tests.
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.SECRET_ENCRYPTION_MASTER_KEY ??= TEST_KEY;
process.env.TOTP_MASTER_KEY_CURRENT ??= Buffer.alloc(32, 9).toString('base64');
