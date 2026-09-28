#!/usr/bin/env node
/**
 * Real, runnable validation checks for the Windows installer source
 * (P3 item 16 - "add tests where practical for installer-generation
 * logic/configuration"). Not a Jest suite (this directory sits outside
 * any app's own Jest config, and pulling in a full Jest dependency for a
 * handful of static-file assertions would be disproportionate) - a
 * plain Node script with real assertions and a real non-zero exit code
 * on failure, runnable in CI or by hand: `node scripts/windows/__tests__/validate-installer-source.js`.
 *
 * Validates exactly what the coordinator's instructions asked for that
 * is genuinely checkable from file content alone (without a WiX
 * toolchain or a Windows machine): installer source is well-formed XML;
 * PostgreSQL major version referenced is 17, never 16; no production
 * secrets/passwords are hard-coded anywhere in the installer sources or
 * scripts; the service account is not the LocalSystem placeholder
 * anymore; the WiX toolchain version referenced in documentation is
 * pinned to 4.0.6, not an unpinned "latest" (which resolved to WiX 7 on
 * the real build machine - see docs/WINDOWS_ACCEPTANCE_PREP.md); the
 * root package.json build script builds packages/* before apps/* (the
 * real ordering bug found and fixed this round).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL: ${name}\n  ${err.message}`);
  }
}

function read(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- XML well-formedness: shell out to a REAL XML parser, not a hand-rolled
// regex (a naive open/close tag regex false-positives on angle brackets
// inside XML comments - e.g. this file's own explanatory comments quoting
// example WiX syntax - which is a bug in a regex, not in the WiX source).
// PowerShell's native [xml] cast (System.Xml under the hood) is a genuine
// parser and is always available on the Windows machines this script
// actually matters on; falls back to a Node DOMParser-free tolerant check
// only if powershell.exe truly isn't reachable (e.g. a non-Windows CI
// runner), clearly labelled as the weaker fallback so it's never confused
// with a real parse.
check('Product.wxs and Bundle.wxs are well-formed XML', () => {
  const files = ['installer/windows/Product.wxs', 'installer/windows/Bundle.wxs'];
  let havePowerShell = true;
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
  } catch {
    havePowerShell = false;
  }
  for (const f of files) {
    const xml = read(f);
    assert(xml.trim().startsWith('<?xml'), `${f} does not start with an XML declaration`);
    if (havePowerShell) {
      const script = `try { [xml](Get-Content '${path.join(REPO_ROOT, f)}' -Raw) | Out-Null; Write-Output 'OK' } catch { Write-Output "ERROR: $($_.Exception.Message)" }`;
      const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
      assert(out === 'OK', `${f} failed real XML parsing: ${out}`);
    } else {
      console.warn(`  (no powershell available - only checked ${f} starts with an XML declaration, not full well-formedness)`);
    }
  }
});

check('Installer source targets PostgreSQL 17, never 16', () => {
  const productWxs = read('installer/windows/Product.wxs');
  const designDoc = read('docs/WINDOWS_INSTALLER_DESIGN.md');
  assert(!/postgres(ql)?[\s:]*16\b/i.test(productWxs.replace(/PostgreSQL\/17/g, '')), 'Product.wxs references PostgreSQL 16');
  assert(/PostgreSQL 17/.test(designDoc), 'WINDOWS_INSTALLER_DESIGN.md does not mention PostgreSQL 17');
  assert(!/postgres:16-alpine/.test(designDoc), 'WINDOWS_INSTALLER_DESIGN.md still references postgres:16-alpine');
});

check('No hard-coded production secrets/passwords in installer sources or Windows scripts', () => {
  const filesToScan = [
    'installer/windows/Product.wxs',
    'installer/windows/Bundle.wxs',
    'scripts/windows/build-release-payload.ps1',
    'scripts/windows/generate-credentials.ps1',
    'scripts/windows/provision-postgres.ps1',
  ];
  const suspiciousPatterns = [/password\s*=\s*['"][^$][^'"]{4,}['"]/i, /-----BEGIN (RSA |EC )?PRIVATE KEY-----/];
  for (const f of filesToScan) {
    const content = read(f);
    for (const pattern of suspiciousPatterns) {
      assert(!pattern.test(content), `${f} contains what looks like a hard-coded secret (matched ${pattern})`);
    }
  }
});

check('Service account is not the LocalSystem placeholder', () => {
  const productWxs = read('installer/windows/Product.wxs');
  assert(/Account="NT SERVICE\\HexyrnCore"/.test(productWxs), 'Product.wxs ServiceInstall Account is not set to the NT SERVICE virtual account');
  assert(!/Account="LocalSystem"/.test(productWxs), 'Product.wxs still has a live Account="LocalSystem" (should be the NT SERVICE virtual account)');
});

check('WiX toolchain version is pinned to 4.0.6 in acceptance prep docs, not an unpinned "latest"', () => {
  const prep = read('docs/WINDOWS_ACCEPTANCE_PREP.md');
  assert(/wix@4\.0\.6|--version 4\.0\.6/.test(prep), 'WINDOWS_ACCEPTANCE_PREP.md does not pin the wix CLI install to 4.0.6');
  assert(/WixToolset\.Util\.wixext\/4\.0\.6|WixToolset\.Util\.wixext@4\.0\.6/.test(prep), 'WINDOWS_ACCEPTANCE_PREP.md does not pin WixToolset.Util.wixext to 4.0.6');
  assert(/WixToolset\.Bal\.wixext\/4\.0\.6|WixToolset\.Bal\.wixext@4\.0\.6/.test(prep), 'WINDOWS_ACCEPTANCE_PREP.md does not pin WixToolset.Bal.wixext to 4.0.6');
  assert(!/dotnet tool install --global wix\s*$/m.test(prep), 'WINDOWS_ACCEPTANCE_PREP.md still has an unpinned `dotnet tool install --global wix` (would resolve to latest/WiX 7)');
});

check('Root package.json build script builds packages/* before apps/* (topological ordering fix)', () => {
  const pkg = JSON.parse(read('package.json'));
  const buildScript = pkg.scripts && pkg.scripts.build;
  assert(buildScript, 'package.json has no "build" script');
  assert(buildScript.includes('build:packages'), '"build" script does not reference "build:packages" - the topological-ordering fix may have regressed');
  const buildPackagesScript = pkg.scripts['build:packages'];
  assert(buildPackagesScript && /shared-types/.test(buildPackagesScript) && /app-sdk/.test(buildPackagesScript), '"build:packages" does not build shared-types/app-sdk');
});

check('No test/dev-only signing or licence trust material referenced as if it were production in installer docs', () => {
  const designDoc = read('docs/WINDOWS_INSTALLER_DESIGN.md');
  const prep = read('docs/WINDOWS_ACCEPTANCE_PREP.md');
  // The acceptance prep doc's signing step must reference a REAL cert/key
  // placeholder path, never the repo's own committed TEST keys.
  assert(!/TEST_RELEASE_PRIVATE_KEY|TEST_LICENSE_PRIVATE_KEY/.test(prep), 'WINDOWS_ACCEPTANCE_PREP.md references a committed TEST signing key as if used for the real signed artifact');
  assert(/real.*(signing|release).*key/i.test(prep), 'WINDOWS_ACCEPTANCE_PREP.md does not explicitly call out using the REAL production signing key');
  void designDoc;
});

check('The registered service runs the file the payload actually contains (payload keeps apps/api/dist/main.js under ApiFolder)', () => {
  const wxs = read('installer/windows/Product.wxs');
  const payload = read('scripts/windows/build-release-payload.ps1');
  assert(/\$apiOut\s*=\s*Join-Path \$OutDir 'apps\\api'/.test(payload), 'payload staging no longer places the API under apps\\api - update the service path together with it');
  assert(wxs.includes('[ApiFolder]apps\\api\\dist\\main.js'), 'HexyrnCore service Arguments must be [ApiFolder]apps\\api\\dist\\main.js (the harvested payload keeps the apps\\api prefix); the old [ApiFolder]dist\\main.js does not exist after install');
});

check('No MSI custom-action command line ends a quoted argument with a directory property (a trailing backslash escapes the closing quote)', () => {
  const wxs = read('installer/windows/Product.wxs');
  // cmd.exe built-ins (rmdir, net) parse differently; powershell.exe and icacls use CommandLineToArgvW rules.
  const bad = (wxs.match(/ExeCommand="[^"]*"/g) || []).filter((c) => /powershell\.exe|icacls/.test(c) && /\[[A-Za-z0-9]*Folder\]&quot;/.test(c));
  assert(bad.length === 0, `directory property directly before a closing quote in: ${bad[0] && bad[0].slice(0, 120)} - append "." (and normalise in the script)`);
});

check('Provisioning migrates, writes the runtime settings file, and ships what it needs', () => {
  const wxs = read('installer/windows/Product.wxs');
  const prov = read('scripts/windows/provision-postgres.ps1');
  const build = read('scripts/windows/build-release.ps1');
  const creds = read('scripts/windows/generate-credentials.ps1');
  for (const arg of ['-RunMigrations', '-NodeExe', '-LicenceKeyFile', '-DataRoot', '-InstallDir']) {
    assert(wxs.includes(arg), `ProvisionHexyrnPostgres custom action does not pass ${arg}`);
  }
  assert(/write-runtime-config\.js/.test(prov), 'provision-postgres.ps1 does not write hexyrn.env');
  assert(/LicencePublicKeyFile/.test(build) && /Mandatory\s*=\s*\$true\)\]\[string\]\$LicencePublicKeyFile/.test(build), 'build-release.ps1 must REQUIRE -LicencePublicKeyFile (an installer without it cannot start in production)');
  assert(wxs.includes('licence-public-key.txt') && wxs.includes('Open-Hexyrn.ps1'), 'Product.wxs does not install the licence key file / launcher script');
  assert(fs.existsSync(path.join(REPO_ROOT, 'scripts/windows/Open-Hexyrn.ps1')), 'scripts/windows/Open-Hexyrn.ps1 is missing');
  assert(/SECRET_ENCRYPTION_MASTER_KEY/.test(creds), 'generate-credentials.ps1 must generate SECRET_ENCRYPTION_MASTER_KEY');
});

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll installer-source validation checks passed.');
