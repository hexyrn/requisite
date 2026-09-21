import { logStructured } from './logger';

describe('logStructured', () => {
  let output: string[] = [];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    output = [];
    spy = jest.spyOn(console, 'log').mockImplementation((line: string) => {
      output.push(line);
    });
  });

  afterEach(() => spy.mockRestore());

  it('emits valid JSON with the required fields', () => {
    logStructured({ event: 'login.success', userRef: 'user-1', correlationId: 'corr-1' });
    const parsed = JSON.parse(output[0]);
    expect(parsed.event).toBe('login.success');
    expect(parsed.userRef).toBe('user-1');
    expect(parsed.correlationId).toBe('corr-1');
  });

  it('redacts context keys that look sensitive, structurally not conventionally', () => {
    logStructured({
      event: 'login.failed',
      context: { password: 'hunter2', totpSecret: 'abc', authorizationHeader: 'Bearer xyz', attempt: 3 },
    });
    const parsed = JSON.parse(output[0]);
    expect(parsed.context.password).toBe('[REDACTED]');
    expect(parsed.context.totpSecret).toBe('[REDACTED]');
    expect(parsed.context.authorizationHeader).toBe('[REDACTED]');
    expect(parsed.context.attempt).toBe(3);
  });

  it('redacts nested sensitive keys', () => {
    logStructured({ event: 'x', context: { nested: { sessionToken: 'abc', ok: true } } });
    const parsed = JSON.parse(output[0]);
    expect(parsed.context.nested.sessionToken).toBe('[REDACTED]');
    expect(parsed.context.nested.ok).toBe(true);
  });
});
