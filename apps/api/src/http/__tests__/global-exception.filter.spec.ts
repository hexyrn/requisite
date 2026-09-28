import { ArgumentsHost, BadRequestException, ForbiddenException } from '@nestjs/common';
import { GlobalExceptionFilter } from '../global-exception.filter';

function fakeHost(requestId: string) {
  const sendCalls: any[] = [];
  const statusCalls: number[] = [];
  const response = {
    status(code: number) {
      statusCalls.push(code);
      return this;
    },
    send(body: any) {
      sendCalls.push(body);
      return this;
    },
  };
  const request = { id: requestId, url: '/api/v1/test-path', method: 'POST' };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, response, request, sendCalls, statusCalls };
}

describe('GlobalExceptionFilter (P3 item 13/23)', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('passes through an HttpException (our own deliberately-thrown, already-safe errors) with its real status/message, plus a referenceId', () => {
    const filter = new GlobalExceptionFilter();
    const { host, sendCalls, statusCalls } = fakeHost('req-abc-123');

    filter.catch(new BadRequestException('Every line needs a description.'), host);

    expect(statusCalls).toEqual([400]);
    expect(sendCalls[0].message).toBe('Every line needs a description.');
    expect(sendCalls[0].referenceId).toBe('req-abc-123');
  });

  it('passes through a ForbiddenException correctly too (different status)', () => {
    const filter = new GlobalExceptionFilter();
    const { host, sendCalls, statusCalls } = fakeHost('req-def-456');

    filter.catch(new ForbiddenException('You do not have permission.'), host);

    expect(statusCalls).toEqual([403]);
    expect(sendCalls[0].message).toBe('You do not have permission.');
  });

  it('NEVER leaks a raw (non-HttpException) error message to the client - generic message + referenceId only', () => {
    const filter = new GlobalExceptionFilter();
    const { host, sendCalls, statusCalls } = fakeHost('req-ghi-789');

    const rawError = new Error(
      'duplicate key value violates unique constraint "user_accounts_email_key" DETAIL: Key (email)=(admin@real-customer.example) already exists.',
    );
    filter.catch(rawError, host);

    expect(statusCalls).toEqual([500]);
    const body = sendCalls[0];
    expect(body.message).not.toContain('duplicate key value');
    expect(body.message).not.toContain('user_accounts_email_key'); // no table/column name leakage (SQL internals)
    expect(body.message).not.toContain('admin@real-customer.example'); // no data value leakage
    expect(body.message).toContain('req-ghi-789'); // the reference ID IS surfaced, so the user can quote it
    expect(body.referenceId).toBe('req-ghi-789');
  });

  it('never leaks a stack trace to the client', () => {
    const filter = new GlobalExceptionFilter();
    const { host, sendCalls } = fakeHost('req-stack-test');

    const rawError = new Error('boom');
    filter.catch(rawError, host);

    const serialized = JSON.stringify(sendCalls[0]);
    expect(serialized).not.toContain('at Object'); // typical stack trace frame text
    expect(serialized).not.toContain(__filename); // this test file's own path would appear in a real stack
  });

  it('logs the FULL error detail server-side (for support/debugging) even though the client never sees it', () => {
    const filter = new GlobalExceptionFilter();
    const { host } = fakeHost('req-logged-1');

    filter.catch(new Error('the real underlying cause'), host);

    expect(consoleSpy).toHaveBeenCalled();
    const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logged.context.errorMessage).toContain('the real underlying cause');
    expect(logged.correlationId).toBe('req-logged-1');
  });

  it("scrubs a credential-shaped substring out of the SERVER-SIDE logged error message too (defense in depth, reuses support-bundle.service.ts's scrubFreeText)", () => {
    const filter = new GlobalExceptionFilter();
    const { host } = fakeHost('req-logged-2');

    filter.catch(
      new Error(
        'upstream call failed: Authorization: Bearer sk-live-canary-credential-abcdef123456',
      ),
      host,
    );

    const logged = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(logged.context.errorMessage).not.toContain('sk-live-canary-credential-abcdef123456');
  });

  it('handles a thrown non-Error value (e.g. a string or plain object) without crashing', () => {
    const filter = new GlobalExceptionFilter();
    const { host, sendCalls, statusCalls } = fakeHost('req-weird-throw');

    expect(() => filter.catch('a raw thrown string, not an Error', host)).not.toThrow();
    expect(statusCalls).toEqual([500]);
    expect(sendCalls[0].referenceId).toBe('req-weird-throw');
  });
});
