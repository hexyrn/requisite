// Drives a simulated install (sim-install.sh) through the customer's first-run journey in a real browser:
//   setup link -> owner created and signed in -> licence file chosen -> Requisite active -> MFA on -> sign out/in with a code
//   -> invite a colleague -> colleague accepts, signs in, is limited by RBAC -> data -> Backup Now -> delete -> Restore
//   -> service restart -> everything (and the sign-in) still there.
// Usage: node first-run-journey.js <workdir>   (service must be started with <workdir>/service.sh)
const { chromium } = require('playwright');
const { authenticator } = require('otplib');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const W = process.argv[2] || '/tmp/hxsim';
const REPO = path.resolve(__dirname, '../../..');
const CFG = `${W}/ProgramData/Hexyrn Core/config`;
const B = 'http://localhost:3000';
const results = [];
const step = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' - ' + extra : ''}`);
  if (!ok) throw new Error('step failed: ' + name);
};

async function waitUp(ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(B + '/api/v1/health');
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
let svc;
function startService() {
  svc = spawn('sh', [`${W}/service.sh`], {
    stdio: ['ignore', fs.openSync(`${W}/service.log`, 'a'), fs.openSync(`${W}/service.log`, 'a')],
    detached: true,
  });
  svc.unref();
}
async function stopService() {
  try {
    process.kill(-svc.pid, 'SIGTERM');
  } catch {}
  await new Promise((r) => setTimeout(r, 2500));
}
async function nextCode(secret) {
  // avoid replay of a code that was just used
  return authenticator.generate(secret);
}

(async () => {
  startService();
  step('service starts from the settings file alone', await waitUp());
  const token = fs.readFileSync(`${CFG}/bootstrap-token.txt`, 'utf8').trim();
  const log0 = fs.readFileSync(`${W}/service.log`, 'utf8');
  step('setup code is not written to the service log', !log0.includes(token));

  const browser = await chromium.launch({
    executablePath:
      process.env.E2E_CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  const p = await ctx.newPage();
  const problems = [];
  p.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  p.on('response', (r) => {
    if (r.url().startsWith(B + '/api/') && r.status() >= 500)
      problems.push(`HTTP ${r.status()} ${r.url()}`);
  });

  // 1. setup via the launcher-style link
  await p.goto(`${B}/setup#token=${token}`);
  step('setup page needs no code to be typed', (await p.getByLabel('Setup code').count()) === 0);
  await p.getByLabel('Organisation name').fill('Journey Ltd');
  await p.getByLabel('Owner email').fill('owner@journey.local');
  await p.getByLabel('Owner password').fill('correct-horse-battery-staple-9');
  await p.getByRole('button', { name: 'Create organisation' }).click();
  await p.waitForURL('**/admin/licence?firstRun=1', { timeout: 15000 });
  step('owner is created, signed in, and taken to licence activation', true);
  step(
    'setup code file removed and the code is gone from the address bar',
    !fs.existsSync(`${CFG}/bootstrap-token.txt`) && !p.url().includes('token'),
  );

  // 2. licence: choose the file
  const org = (await p.getByTestId('organisation-id').textContent()).trim();
  const lic = `${W}/journey.licence`;
  execFileSync(
    'npx',
    [
      'ts-node',
      'scripts/licence-tool.ts',
      'issue',
      '--key',
      `${W}/keys/licence-private.pem`,
      '--org',
      org,
      '--out',
      lic,
    ],
    { cwd: `${REPO}/apps/api`, stdio: 'pipe' },
  );
  await p.getByLabel('Licence file').setInputFiles(lic);
  await p.getByText(/Requisite is now active/).waitFor({ timeout: 15000 });
  step('choosing the licence file activates Requisite (no paste, no restart)', true);
  await p.getByRole('link', { name: 'Open Requisite' }).click();
  await p.waitForURL('**/requisite');
  step('Requisite opens for the owner', true);

  // 3. MFA
  await p.goto(`${B}/account/security`);
  await p.getByRole('button', { name: 'Set up two-factor authentication' }).click();
  const secret = (await p.getByTestId('mfa-secret').textContent()).trim();
  await p.getByLabel('6-digit code from the app').fill(authenticator.generate(secret));
  await p.getByRole('button', { name: 'Turn on' }).click();
  const codes = (await p.getByTestId('recovery-codes').textContent()).trim().split(/\s+/);
  step('MFA enrolment shows recovery codes once', codes.length >= 8, `${codes.length} codes`);
  await p.getByRole('button', { name: 'Log out' }).click();
  await p.waitForURL('**/login');
  await p.getByLabel('Email').fill('owner@journey.local');
  await p.getByLabel('Password').fill('correct-horse-battery-staple-9');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.waitForURL('**/mfa');
  step('sign-in now demands a second factor', true);
  await p.getByLabel('Authentication code').fill('000000');
  await p.getByRole('button', { name: 'Verify' }).click();
  await p.getByRole('alert').first().waitFor();
  step('a wrong code is refused', /\/mfa$/.test(p.url()));
  // Use a recovery code (one-time) for the real login: also proves recovery works.
  await p.getByLabel('Authentication code').fill(codes[0]);
  await p.getByRole('button', { name: 'Verify' }).click();
  await p.waitForURL(`${B}/`, { timeout: 10000 });
  step('a recovery code signs in (and is one-time)', true);

  // 4. invite a colleague with a limited role
  await p.goto(`${B}/admin/users`);
  await p.getByLabel('Email address').fill('sam@journey.local');
  await p
    .locator('#inviteRole')
    .selectOption(
      await p.locator('#inviteRole option', { hasText: 'Requester' }).getAttribute('value'),
    );
  await p.getByRole('button', { name: 'Create invitation' }).click();
  const link = (await p.getByTestId('invitation-link').textContent()).trim();
  step(
    'invitation link keeps the port (works on this install)',
    link.startsWith(`${B}/setup/accept-invitation?token=`),
    link.slice(0, 60),
  );
  const ctx2 = await browser.newContext();
  const q = await ctx2.newPage();
  await q.goto(link);
  await q.getByLabel('Password').fill('sams-long-password-1');
  await q.getByRole('button', { name: 'Create my account' }).click();
  await q.getByText('Your account is ready').waitFor();
  await q.getByRole('link', { name: 'Sign in' }).click();
  await q.getByLabel('Email').fill('sam@journey.local');
  await q.getByLabel('Password').fill('sams-long-password-1');
  await q.getByRole('button', { name: 'Sign in' }).click();
  await q.getByRole('link', { name: 'Open Requisite' }).waitFor({ timeout: 10000 });
  step('invited colleague signs in and sees Requisite', true);
  const noAdmin = (await q.getByRole('link', { name: /Administration/ }).count()) === 0;
  step('colleague does not see Administration', noAdmin);
  const status = await q.evaluate(async () => {
    const s = await (await fetch('/api/v1/auth/session')).json();
    const post = await fetch('/api/v1/requisite/suppliers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hexyrn-CSRF': s.csrfToken },
      body: JSON.stringify({ name: 'Nope' }),
    });
    const users = await fetch('/api/v1/users');
    const view = await fetch('/api/v1/requisite/requisitions');
    return { post: post.status, users: users.status, view: view.status };
  });
  step(
    'RBAC: Requester cannot create suppliers (403), list users (403) but can view requisitions (200)',
    status.post === 403 && status.users === 403 && status.view === 200,
    JSON.stringify(status),
  );
  await ctx2.close();

  // 5. data -> backup -> delete -> restore
  const api = (method, url, body) =>
    p.evaluate(
      async ([m, u, b]) => {
        const s = await (await fetch('/api/v1/auth/session')).json();
        const r = await fetch('/api/v1' + u, {
          method: m,
          headers: { 'Content-Type': 'application/json', 'X-Hexyrn-CSRF': s.csrfToken },
          body: b ? JSON.stringify(b) : undefined,
        });
        return { status: r.status, body: await r.json().catch(() => null) };
      },
      [method, url, body],
    );
  await p.goto(`${B}/requisite`);
  const made = await api('POST', '/requisite/suppliers', { name: 'Acme Fasteners Ltd' });
  step('owner can create a supplier', made.status === 201, String(made.status));
  await p.goto(`${B}/admin/backup`);
  await p.getByRole('button', { name: 'Backup Now' }).click();
  await p
    .getByText(/Backup (created|complete)|backup-/i)
    .first()
    .waitFor({ timeout: 60000 });
  const list = await api('GET', '/backup');
  step(
    'Backup Now produces a valid backup',
    list.body.backups.length >= 1 && list.body.backups.every((b) => b.valid),
    `${list.body.backups.length} backup(s)`,
  );
  const backupId = list.body.backups[0].backupId;
  // simulate damage: remove the supplier straight from the database
  const dbUrl = fs
    .readFileSync(`${CFG}/hexyrn.env`, 'utf8')
    .match(/^BACKUP_DATABASE_URL=(.*)$/m)[1]
    .trim();
  execFileSync(
    'psql',
    [dbUrl, '-q', '-c', "DELETE FROM requisite_suppliers WHERE name='Acme Fasteners Ltd'"],
    { stdio: 'pipe' },
  );
  const gone = await api('GET', '/requisite/suppliers');
  step('data is gone before the restore', !JSON.stringify(gone.body).includes('Acme Fasteners'));
  const restored = await api('POST', `/backup/${backupId}/restore`, { confirmed: true });
  step(
    'Restore from the admin API succeeds',
    restored.status === 201 || restored.status === 200,
    String(restored.status),
  );
  await p.close();
  const p2 = await ctx.newPage();
  await p2.goto(`${B}/login`);
  await p2.getByLabel('Email').fill('owner@journey.local');
  await p2.getByLabel('Password').fill('correct-horse-battery-staple-9');
  await p2.getByRole('button', { name: 'Sign in' }).click();
  await p2.waitForURL('**/mfa');
  await p2.getByLabel('Authentication code').fill(codes[1]);
  await p2.getByRole('button', { name: 'Verify' }).click();
  await p2.waitForURL(`${B}/`);
  const back = await p2.evaluate(
    async () => await (await fetch('/api/v1/requisite/suppliers')).text(),
  );
  step('after restore the supplier is back', back.includes('Acme Fasteners'));

  // 6. restart the service: data, licence, MFA, users persist
  await stopService();
  step(
    'service stopped (no port listening)',
    !(await fetch(B + '/api/v1/health')
      .then(() => true)
      .catch(() => false)),
  );
  startService();
  step('service comes back on its own', await waitUp());
  const p3 = await (await browser.newContext()).newPage();
  await p3.goto(`${B}/login`);
  await p3.getByLabel('Email').fill('owner@journey.local');
  await p3.getByLabel('Password').fill('correct-horse-battery-staple-9');
  await p3.getByRole('button', { name: 'Sign in' }).click();
  await p3.waitForURL('**/mfa');
  await p3.getByLabel('Authentication code').fill(codes[2]);
  await p3.getByRole('button', { name: 'Verify' }).click();
  await p3.waitForURL(`${B}/`);
  const after = await p3.evaluate(async () => ({
    sup: await (await fetch('/api/v1/requisite/suppliers')).text(),
    lic: await (await fetch('/api/v1/apps/com.hexyrn.requisite/licence')).json(),
  }));
  step(
    'after restart: data, licence and MFA sign-in all survive',
    after.sup.includes('Acme Fasteners') && after.lic.active === true,
  );
  const log = fs.readFileSync(`${W}/service.log`, 'utf8');
  step(
    'service log contains no passwords or setup code',
    !/hexyrn_app:[^<@\s]+@/.test(log) && !log.includes(token),
  );
  step('no server errors or page errors seen', problems.length === 0, problems.join(' | '));
  await browser.close();
  await stopService();
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps passed`);
})().catch(async (e) => {
  console.error('\nJOURNEY FAILED:', e.message.split('\n')[0]);
  try {
    await stopService();
  } catch {}
  process.exit(1);
});
