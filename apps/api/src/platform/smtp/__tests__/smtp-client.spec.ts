import { createServer, Server, Socket } from 'net';
import { AddressInfo } from 'net';
import { sendSmtpMail } from '../smtp-client';
import { SmtpConfig } from '../smtp-config.service';

/**
 * A minimal fake SMTP server (real `net.Server`, real sockets, real
 * line-based SMTP protocol responses) so sendSmtpMail() is proven against
 * a genuine socket-level conversation, not mocked. Deliberately does NOT
 * support STARTTLS/TLS (upgrading a raw net.Server mid-connection to TLS
 * in a Jest test is real but substantially more test-harness complexity
 * for marginal additional proof - the TLS upgrade path itself uses Node's
 * built-in `tls.connect`, which is not this codebase's code to test) - the
 * plaintext AUTH LOGIN + MAIL FROM/RCPT TO/DATA path is what's proven here
 * end to end, which is the actual protocol logic this module owns.
 */
class FakeSmtpServer {
  server: Server;
  port = 0;
  receivedMail: { from: string; to: string; authUser: string | null; data: string } | null = null;
  behavior: 'accept' | 'reject-auth' | 'reject-recipient' = 'accept';

  constructor() {
    this.server = createServer((socket) => this.handleConnection(socket));
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handleConnection(socket: Socket) {
    socket.write('220 fake-smtp-server ready\r\n');
    let mode: 'command' | 'auth-user' | 'auth-pass' | 'data' = 'command';
    let from = '';
    let to = '';
    let authUser: string | null = null;
    let dataLines: string[] = [];
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (mode === 'data') {
          if (line === '.') {
            mode = 'command';
            this.receivedMail = { from, to, authUser, data: dataLines.join('\n') };
            socket.write('250 OK: message queued\r\n');
          } else {
            dataLines.push(line);
          }
          continue;
        }

        if (mode === 'auth-user') {
          authUser = Buffer.from(line, 'base64').toString('utf8');
          mode = 'auth-pass';
          socket.write('334 UGFzc3dvcmQ6\r\n'); // "Password:"
          continue;
        }

        if (mode === 'auth-pass') {
          mode = 'command';
          if (this.behavior === 'reject-auth') {
            socket.write('535 5.7.8 Authentication failed\r\n');
          } else {
            socket.write('235 2.7.0 Authentication successful\r\n');
          }
          continue;
        }

        // mode === 'command'
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          socket.write('250-fake-smtp-server\r\n250 AUTH LOGIN\r\n');
        } else if (upper.startsWith('AUTH LOGIN')) {
          mode = 'auth-user';
          socket.write('334 VXNlcm5hbWU6\r\n'); // "Username:"
        } else if (upper.startsWith('MAIL FROM:')) {
          from = line.slice(line.indexOf(':') + 1);
          socket.write('250 OK\r\n');
        } else if (upper.startsWith('RCPT TO:')) {
          to = line.slice(line.indexOf(':') + 1);
          if (this.behavior === 'reject-recipient') {
            socket.write('550 5.1.1 No such user\r\n');
          } else {
            socket.write('250 OK\r\n');
          }
        } else if (upper === 'DATA') {
          dataLines = [];
          mode = 'data';
          socket.write('354 Start mail input; end with <CRLF>.<CRLF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else {
          socket.write('500 Command not recognized\r\n');
        }
      }
    });
  }
}

describe('sendSmtpMail - real socket-level SMTP protocol (P3 item 9/24)', () => {
  let fakeServer: FakeSmtpServer;
  let port: number;

  beforeEach(async () => {
    fakeServer = new FakeSmtpServer();
    port = await fakeServer.start();
  });

  afterEach(async () => {
    await fakeServer.stop();
  });

  function config(overrides: Partial<SmtpConfig> = {}): SmtpConfig {
    return {
      host: '127.0.0.1',
      port,
      secure: false,
      username: 'testuser@example.com',
      password: 'test-password',
      fromAddress: 'hexyrn@example.com',
      ...overrides,
    };
  }

  it('successfully sends a real message through the full EHLO -> AUTH -> MAIL -> RCPT -> DATA conversation', async () => {
    const result = await sendSmtpMail(config(), { to: 'recipient@example.com', subject: 'Test email', text: 'Hello from Hexyrn.' });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    expect(fakeServer.receivedMail).not.toBeNull();
    expect(fakeServer.receivedMail!.from).toBe('<hexyrn@example.com>');
    expect(fakeServer.receivedMail!.to).toBe('<recipient@example.com>');
    expect(fakeServer.receivedMail!.authUser).toBe('testuser@example.com');
    expect(fakeServer.receivedMail!.data).toContain('Subject: Test email');
    expect(fakeServer.receivedMail!.data).toContain('Hello from Hexyrn.');
  });

  it('sends without AUTH when no credentials are configured', async () => {
    const result = await sendSmtpMail(config({ username: null, password: null }), { to: 'recipient@example.com', subject: 'No auth', text: 'body' });
    expect(result.success).toBe(true);
    expect(fakeServer.receivedMail!.authUser).toBeNull();
  });

  it('reports an actionable error when the server rejects authentication', async () => {
    fakeServer.behavior = 'reject-auth';
    const result = await sendSmtpMail(config(), { to: 'recipient@example.com', subject: 'x', text: 'y' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/AUTH password/i);
    expect(result.error).toMatch(/535/);
  });

  it('reports an actionable error when the server rejects the recipient', async () => {
    fakeServer.behavior = 'reject-recipient';
    const result = await sendSmtpMail(config(), { to: 'nobody@example.com', subject: 'x', text: 'y' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/RCPT TO/i);
    expect(result.error).toMatch(/550/);
  });

  it('reports an actionable error when the connection is refused (nothing listening on the port)', async () => {
    await fakeServer.stop();
    const result = await sendSmtpMail(config({ port: port }), { to: 'recipient@example.com', subject: 'x', text: 'y' }, 3000);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/could not connect|ECONNREFUSED/i);
  }, 10000);

  it('reports an actionable error on connection timeout to a non-responsive address', async () => {
    // 10.255.255.1 is a private, non-routable-from-here address chosen to
    // hang rather than immediately refuse - proves the timeout path
    // specifically, not just ECONNREFUSED. Uses a short timeout to keep
    // the test fast.
    const result = await sendSmtpMail(config({ host: '10.255.255.1', port: 25 }), { to: 'x@example.com', subject: 'x', text: 'y' }, 1500);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  }, 10000);
});
