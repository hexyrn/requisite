import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Loads settings from a plain `KEY=value` file into process.env.
 *
 * Why this exists: on Windows the API runs as a Windows Service, and a
 * service has no shell to export variables from and a working directory of
 * C:\Windows\System32 (so dotenv's "./.env" never finds anything). The
 * installer writes one settings file under ProgramData and the app finds it
 * itself. Docker/dev keep using real environment variables / ./.env.
 *
 * Precedence: a variable that is ALREADY set in the environment always wins
 * over the file, so an operator can override any single setting without
 * editing the file.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && /^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** HEXYRN_ENV_FILE if set, else (Windows only) %ProgramData%\Hexyrn Core\config\hexyrn.env if it exists. */
export function resolveEnvFilePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (env.HEXYRN_ENV_FILE) return env.HEXYRN_ENV_FILE;
  if (platform === 'win32' && env.ProgramData) {
    const candidate = join(env.ProgramData, 'Hexyrn Core', 'config', 'hexyrn.env');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export interface LoadEnvFileResult {
  path?: string;
  applied: string[];
}

export function loadEnvFile(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): LoadEnvFileResult {
  const path = resolveEnvFilePath(env, platform);
  if (!path) return { applied: [] };
  if (!existsSync(path)) {
    // An explicitly configured file that is missing is a deployment error, not something to ignore.
    throw new Error(`HEXYRN_ENV_FILE points at "${path}" but that file does not exist.`);
  }
  const values = parseEnvFile(readFileSync(path, 'utf8'));
  const applied: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) {
      env[key] = value;
      applied.push(key);
    }
  }
  return { path, applied };
}
