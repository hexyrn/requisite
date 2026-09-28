// Side-effect module: MUST be imported before anything that reads process.env.
// (Kept separate from env-file.ts so importing the pure functions in tests has no side effects.)
import { loadEnvFile } from './env-file';

loadEnvFile();
