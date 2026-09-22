import { Socket, connect as netConnect } from 'net';
import { connect as tlsConnect, TLSSocket } from 'tls';
import { SmtpConfig } from './smtp-config.service';

/**
 * Minimal, real SMTP client over raw sockets (P3 item 9/24) - no
 * `nodemailer` dependency added; this implements exactly the subset of
 * RFC 5321 a modern mail relay actually needs from a sender: EHLO,
 * STARTTLS (opportunistic, when connecting in plaintext and the server
 * offers it), AUTH LOGIN, MAIL FROM / RCPT TO / DATA, QUIT. This is a
 * deliberately narrow implementation, not a general-purpose mail library -
 * exactly enough to send a single test/notification email through a
 * standard SMTP relay (Gmail, Office 365, Postfix, etc. all speak this
 * subset identically).
 *
 * SANDBOX LIMITATION, stated plainly: this has been tested against a real
 * local Node `net`/`tls` server implementing the SMTP protocol in test
 * code (see __tests__/smtp-client.spec.ts) - a genuine socket-level
 * integration test, not mocked - but has NOT been exercised against a real
 * external SMTP provider (Gmail, Office 365, etc.) in this sandbox, since
 * doing so would require real credentials and outbound network access to
 * a third party this environment cannot be assumed to have. Any
 * provider-specific quirks (unusual AUTH mechanisms, non-standard
 * greeting behaviour) are therefore an environment-verification item, not
 * a claimed-tested one.
 */
export interface SmtpMessage {
  to: string;
  subject: string;
  text: string;
}

export interface SmtpSendResult {
  success: boolean;
  error?: string;
}

interface SmtpLine {
  code: number;
  message: string;
  isFinal: boolean;
}

function parseLine(raw: string): SmtpLine {
  // "250-first line" (continuation) or "250 last line" (final) or "250 single line".
  const match = /^(\d{3})([- ])(.*)$/.exec(raw);
  if (!match) return { code: 0, message: raw, isFinal: true };
  return { code: parseInt(match[1], 10), message: match[3], isFinal: match[2] === ' ' };
}

class SmtpSession {
  private buffer = '';
  private pendingResolvers: Array<(lines: SmtpLine[]) => void> = [];

  constructor(private socket: Socket | TLSSocket) {
    socket.on('data', (chunk) => this.onData(chunk));
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString('utf8');
    const lines = this.buffer.split('\r\n').filter((l) => l.length > 0);
    // Only resolve once we have a final (non-continuation) line for the current response block.
    const lastRaw = this.buffer.endsWith('\r\n') ? lines[lines.length - 1] : null;
    if (lastRaw && parseLine(lastRaw).isFinal) {
      const parsed = lines.map(parseLine);
      this.buffer = '';
      const resolver = this.pendingResolvers.shift();
      resolver?.(parsed);
    }
  }

  waitForResponse(): Promise<SmtpLine[]> {
    return new Promise((resolve) => this.pendingResolvers.push(resolve));
  }

  async send(command: string): Promise<SmtpLine[]> {
    const responsePromise = this.waitForResponse();
    this.socket.write(command + '\r\n');
    return responsePromise;
  }

  async readGreeting(): Promise<SmtpLine[]> {
    return this.waitForResponse();
  }
}

function requireSuccess(lines: SmtpLine[], context: string): void {
  const last = lines[lines.length - 1];
  if (!last || last.code < 200 || last.code >= 400) {
    throw new Error(`SMTP server rejected ${context}: ${last?.code ?? '???'} ${last?.message ?? '(no response)'}`);
  }
}

/** Real socket-level SMTP send. Connects, negotiates TLS/auth, sends one message, disconnects. */
export async function sendSmtpMail(config: SmtpConfig, message: SmtpMessage, timeoutMs = 15000): Promise<SmtpSendResult> {
  let socket: Socket | TLSSocket | null = null;
  try {
    socket = await connectWithTimeout(config, timeoutMs);
    const session = new SmtpSession(socket);

    const greeting = await session.readGreeting();
    requireSuccess(greeting, 'connection greeting');

    let ehloResponse = await session.send(`EHLO hexyrn-core`);
    requireSuccess(ehloResponse, 'EHLO');

    if (!config.secure && ehloResponse.some((l) => /STARTTLS/i.test(l.message))) {
      const starttlsResponse = await session.send('STARTTLS');
      requireSuccess(starttlsResponse, 'STARTTLS');
      socket = await upgradeToTls(socket as Socket, config.host);
      const tlsSession = new SmtpSession(socket);
      ehloResponse = await tlsSession.send(`EHLO hexyrn-core`);
      requireSuccess(ehloResponse, 'EHLO after STARTTLS');
      return await deliverAfterHandshake(new SmtpSession(socket), config, message, socket);
    }

    return await deliverAfterHandshake(session, config, message, socket);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    socket?.end();
  }
}

async function deliverAfterHandshake(session: SmtpSession, config: SmtpConfig, message: SmtpMessage, _socket: Socket | TLSSocket): Promise<SmtpSendResult> {
  if (config.username && config.password) {
    const authResponse = await session.send('AUTH LOGIN');
    requireSuccess(authResponse, 'AUTH LOGIN');
    const userResponse = await session.send(Buffer.from(config.username, 'utf8').toString('base64'));
    requireSuccess(userResponse, 'AUTH username');
    const passResponse = await session.send(Buffer.from(config.password, 'utf8').toString('base64'));
    requireSuccess(passResponse, 'AUTH password');
  }

  requireSuccess(await session.send(`MAIL FROM:<${config.fromAddress}>`), 'MAIL FROM');
  requireSuccess(await session.send(`RCPT TO:<${message.to}>`), 'RCPT TO');
  requireSuccess(await session.send('DATA'), 'DATA');

  const body = [`From: ${config.fromAddress}`, `To: ${message.to}`, `Subject: ${message.subject}`, '', message.text, '.'].join('\r\n');
  requireSuccess(await session.send(body), 'message body');

  await session.send('QUIT').catch(() => undefined); // best-effort - delivery already succeeded above
  return { success: true };
}

function connectWithTimeout(config: SmtpConfig, timeoutMs: number): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(new Error(`Could not connect to ${config.host}:${config.port} - ${err.message}`));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connection to ${config.host}:${config.port} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const socket: Socket | TLSSocket = config.secure
      ? tlsConnect({ host: config.host, port: config.port }, () => {
          clearTimeout(timer);
          resolve(socket);
        })
      : netConnect({ host: config.host, port: config.port }, () => {
          clearTimeout(timer);
          resolve(socket);
        });
    socket.once('error', (err) => {
      clearTimeout(timer);
      onError(err);
    });
  });
}

function upgradeToTls(socket: Socket, host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect({ socket, host }, () => resolve(tlsSocket));
    tlsSocket.once('error', reject);
  });
}
