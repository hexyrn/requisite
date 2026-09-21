// Loads .env for local test runs (test DB URL etc). Silently no-ops if dotenv isn't present.
try {
  require('dotenv').config();
} catch {
  // dotenv not installed - fine, environment variables are expected to already be set (CI).
}
