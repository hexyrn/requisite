import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadEnvFile, parseEnvFile, resolveEnvFilePath } from '../env-file';

describe('env-file (how a Windows service gets its settings)', () => {
  it('parses KEY=value lines, ignoring comments, blanks, CRLF and quotes', () => {
    const parsed = parseEnvFile(
      '# comment\r\n\r\nA=1\r\nB = two words \r\nC="quoted value"\r\nD=\'single\'\r\nE=has=equals\r\nnot a line\r\n1BAD=x\r\n',
    );
    expect(parsed).toEqual({
      A: '1',
      B: 'two words',
      C: 'quoted value',
      D: 'single',
      E: 'has=equals',
    });
  });

  it('keeps Windows paths with spaces and backslashes intact', () => {
    expect(parseEnvFile('P=C:\\Program Files\\Hexyrn Core\\api').P).toBe(
      'C:\\Program Files\\Hexyrn Core\\api',
    );
  });

  it('never overrides a variable that is already set, and reports what it applied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hx-env-'));
    const file = join(dir, 'hexyrn.env');
    writeFileSync(file, 'FROM_FILE=file\nALREADY_SET=file\n');
    const env: NodeJS.ProcessEnv = { HEXYRN_ENV_FILE: file, ALREADY_SET: 'real-env' };
    const result = loadEnvFile(env, 'linux');
    expect(env.FROM_FILE).toBe('file');
    expect(env.ALREADY_SET).toBe('real-env');
    expect(result.applied).toEqual(['FROM_FILE']);
  });

  it('finds the ProgramData file on Windows only, and is a no-op when nothing is configured', () => {
    const programData = mkdtempSync(join(tmpdir(), 'hx-pd-'));
    expect(resolveEnvFilePath({ ProgramData: programData } as any, 'win32')).toBeUndefined(); // no file yet
    const cfgDir = join(programData, 'Hexyrn Core', 'config');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'hexyrn.env'), 'X=1\n');
    expect(resolveEnvFilePath({ ProgramData: programData } as any, 'win32')).toBe(
      join(cfgDir, 'hexyrn.env'),
    );
    expect(resolveEnvFilePath({ ProgramData: programData } as any, 'linux')).toBeUndefined();
    expect(loadEnvFile({} as any, 'linux')).toEqual({ applied: [] });
  });

  it('fails loudly if an explicitly configured file is missing', () => {
    expect(() =>
      loadEnvFile({ HEXYRN_ENV_FILE: join(tmpdir(), 'nope-hx.env') } as any, 'linux'),
    ).toThrow(/does not exist/);
  });
});
