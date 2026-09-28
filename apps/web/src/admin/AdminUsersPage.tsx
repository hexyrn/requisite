import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Input, StatusBadge } from '@hexyrn/design-system';
import { DirectoryRole, DirectoryUser, usersApi } from '../api/admin';
import { toneForBool } from './statusTone';

/**
 * Users: who has an account, their roles and MFA state, and invitations. An invitation produces a one-time
 * link the administrator sends to the person (the app does not email it). Roles are what grant access: a new
 * person can do only what the role they are invited into allows.
 */
export function AdminUsersPage() {
  const [users, setUsers] = useState<DirectoryUser[] | null>(null);
  const [roles, setRoles] = useState<DirectoryRole[]>([]);
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reload() {
    setError(null);
    Promise.all([usersApi.listUsers(), usersApi.listRoles()])
      .then(([u, r]) => {
        setUsers(u.users);
        setRoles(r.roles);
        setRoleId((current) => current || r.roles[0]?.id || '');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load users.'));
  }
  useEffect(reload, []);

  async function onInvite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setLink(null);
    try {
      const result = await usersApi.invite(email.trim(), roleId ? [roleId] : []);
      setLink(result.invitationUrlForAdmin ?? null);
      setEmail('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the invitation.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error && <Alert>{error}</Alert>}
      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Invite a person</h2>
        <form onSubmit={onInvite} style={{ maxWidth: 480 }}>
          <Input
            label="Email address"
            type="email"
            name="inviteEmail"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <div className="hx-field">
            <label htmlFor="inviteRole">Role</label>
            <select id="inviteRole" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.permissionCount} permissions)
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={busy || !email.trim()}>
            {busy ? 'Creating…' : 'Create invitation'}
          </Button>
        </form>
        {link && (
          <Alert tone="success">
            Send this one-time link to the person (it works once and expires):
            <br />
            <code data-testid="invitation-link" style={{ wordBreak: 'break-all' }}>
              {link}
            </code>
          </Alert>
        )}
      </Card>

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>People</h2>
        {users ? (
          <table className="hx-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th align="left">Email</th>
                <th align="left">Roles</th>
                <th align="left">Two-factor</th>
                <th align="left">Status</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.roles.join(', ') || '—'}</td>
                  <td>
                    <StatusBadge
                      label={u.mfaEnabled ? 'On' : 'Off'}
                      tone={toneForBool(u.mfaEnabled)}
                    />
                  </td>
                  <td>
                    <StatusBadge
                      label={u.isActive ? 'Active' : 'Disabled'}
                      tone={toneForBool(u.isActive)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>Loading…</p>
        )}
      </Card>
    </div>
  );
}
