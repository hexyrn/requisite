import React, { useEffect, useState } from 'react';
import { Card, Button, Input } from '@hexyrn/design-system';
import { smtpApi, SmtpConfigDisplay } from '../api/admin';

/** P3 item 9/24: SMTP configuration + test-send. */
export function AdminSmtpPage() {
  const [config, setConfig] = useState<SmtpConfigDisplay | null>(null);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [secure, setSecure] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [testTo, setTestTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  function reload() {
    setError(null);
    smtpApi
      .get()
      .then((c) => {
        setConfig(c);
        setHost(c.host ?? '');
        setPort(c.port ? String(c.port) : '587');
        setSecure(c.secure ?? false);
        setUsername(c.username ?? '');
        setFromAddress(c.fromAddress ?? '');
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load SMTP configuration.'),
      );
  }

  useEffect(reload, []);

  async function onSave() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await smtpApi.set({
        host,
        port: Number(port),
        secure,
        username: username || undefined,
        password: password || undefined, // blank keeps the existing password (server-side rule)
        fromAddress,
      });
      setPassword('');
      setMessage('SMTP configuration saved.');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Saving the SMTP configuration failed.');
    } finally {
      setSaving(false);
    }
  }

  async function onClear() {
    setSaving(true);
    setError(null);
    try {
      await smtpApi.clear();
      setMessage('SMTP configuration cleared.');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clearing the SMTP configuration failed.');
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    setTesting(true);
    setError(null);
    setMessage(null);
    try {
      const result = await smtpApi.sendTest(testTo);
      setMessage(
        result.success ? `Test email sent to ${testTo}.` : `Test send failed: ${result.error}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test send failed.');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div>
      {error && (
        <div role="alert" style={{ color: 'var(--hx-danger)', marginBottom: 12 }}>
          {error}
        </div>
      )}
      {message && (
        <div role="status" style={{ color: 'var(--hx-success)', marginBottom: 12 }}>
          {message}
        </div>
      )}

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>SMTP configuration</h2>
        <p style={{ color: 'var(--hx-text-muted)', marginBottom: 8 }}>
          {config?.configured ? 'Currently configured.' : 'Not yet configured.'}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 }}>
          <Input label="Host" value={host} onChange={(e) => setHost(e.target.value)} />
          <Input label="Port" value={port} onChange={(e) => setPort(e.target.value)} />
          <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
            Use TLS
          </label>
          <Input label="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <Input
            label="Password (leave blank to keep existing)"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Input
            label="From address"
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={onSave} disabled={saving || !host.trim() || !fromAddress.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="secondary" onClick={onClear} disabled={saving || !config?.configured}>
              Clear
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Send test email</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
          <Input label="Send to" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          <Button onClick={onTest} disabled={testing || !testTo.trim() || !config?.configured}>
            {testing ? 'Sending…' : 'Send Test Email'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
