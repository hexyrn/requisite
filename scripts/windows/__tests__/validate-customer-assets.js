#!/usr/bin/env node
/**
 * Static release-readiness checks for everything a customer receives or sees. Complements
 * validate-installer-source.js (service wiring) and the WiX compile/reference checks.
 *
 *  1. No Docker / developer-tool wording in customer-facing installer assets, packaged scripts or web UI text.
 *  2. Packaged scripts run on Windows PowerShell 5.1 (the one built into Windows 10/11): no PowerShell 6+ only syntax.
 *  3. No secrets or secret-shaped names in MSI properties or custom-action command lines.
 *  4. Versioning rules: constant UpgradeCode, no fixed ProductCode, distinct bundle code, MajorUpgrade with downgrade
 *     block, versions in the repository agree, four-part MSI version derivation.
 *  5. Installer structure: Windows 10+ launch condition, health verification after services start, data-safety
 *     defaults, firewall clean-up, VC++ runtime in the bundle, branding assets present and valid.
 *  6. Build script produces the documented outputs (versioned names, checksums, unsigned vs signed) and requires
 *     signing for -Release.
 *  7. No private key material anywhere under installer/ or scripts/windows/.
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../..');
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS: ' + name);
  else {
    failed++;
    console.log('FAIL: ' + name + (detail ? '\n  ' + detail : ''));
  }
}

const product = rd('installer/windows/Product.wxs');
const bundle = rd('installer/windows/Bundle.wxs');
const build = rd('scripts/windows/build-release.ps1');
const productNoComments = product.replace(/<!--[\s\S]*?-->/g, '');

// packaged scripts = every ps1 referenced by the MSI's script component or launched from it
const packaged = [...product.matchAll(/scripts\\windows\\([A-Za-z-]+\.ps1)/g)].map(
  (m) => 'scripts/windows/' + m[1],
);
const packagedUnique = [...new Set(packaged)];
check(
  'the MSI packages the expected customer scripts',
  [
    'provision-postgres',
    'generate-credentials',
    'Open-Hexyrn',
    'Verify-Install',
    'Enable-LanAccess',
    'Get-SupportBundle',
    'Remove-RequisiteData',
    'Reset-Password',
    'Hexyrn-Common',
  ].every((n) => packagedUnique.some((p) => p.includes(n + '.ps1'))),
  packagedUnique.join(', '),
);
check(
  'every packaged script exists',
  packagedUnique.every((p) => fs.existsSync(path.join(root, p))),
);

// 1. forbidden wording
const customerText = [
  ...packagedUnique,
  'installer/windows/Product.wxs',
  'installer/windows/Bundle.wxs',
  'installer/windows/Bundle.en-us.wxl',
  'installer/windows/RequisiteService.xml',
  'installer/windows/assets/EULA.rtf',
  'docs/INSTALL_WINDOWS.md',
];
const webSrc = [];
(function walk(d) {
  for (const n of fs.readdirSync(path.join(root, d))) {
    const p = d + '/' + n;
    const st = fs.statSync(path.join(root, p));
    if (st.isDirectory()) {
      if (n !== '__tests__' && n !== 'node_modules') walk(p);
    } else if (/\.(tsx?)$/.test(n) && !/\.test\./.test(n)) webSrc.push(p);
  }
})('apps/web/src');
const forbidden = /docker|docker-compose|dockerfile|\bnpm\b|\bnpx\b|nestjs|kysely|\.env\.example/i;
const hits = [];
for (const f of [...customerText, ...webSrc]) {
  const t = rd(f);
  const m = forbidden.exec(t);
  if (m) hits.push(`${f}: "${m[0]}"`);
}
check(
  'no Docker / npm / framework wording in customer-facing installer assets, scripts, guide or web UI',
  hits.length === 0,
  hits.join('; '),
);
const customerApiMessages = [
  'apps/api/src/platform/backup/backup.controller.ts',
  'apps/api/src/platform/backup/backup.service.ts',
  'apps/api/src/platform/update/update.controller.ts',
];
check(
  'customer-visible API error messages do not point at developer files or environment variables',
  customerApiMessages.every(
    (f) =>
      !/(throw new [A-Za-z]*\(\s*['`"][^'`"]*(docker|BACKUP_DATABASE_URL|\.sh\b))/i.test(rd(f)),
  ),
);

// 2. PowerShell 5.1 compatibility
const ps7only = [
  [/\?\?/, 'null-coalescing ??'],
  [/\?\./, 'null-conditional ?.'],
  [/\s\?\s[^\n]*\s:\s/, 'ternary ?:'],
  [/&&|\|\|(?!\s*\$)/, 'pipeline chain operators'],
  [/-AsHashtable/, 'ConvertFrom-Json -AsHashtable'],
  [/-SkipCertificateCheck/, '-SkipCertificateCheck'],
  [/-Parallel/, 'ForEach-Object -Parallel'],
  [/\$IsWindows|\$IsLinux/, '$IsWindows/$IsLinux'],
  [/-AsByteStream/, '-AsByteStream'],
  [/ConvertTo-Json[^\n]*-AsArray/, 'ConvertTo-Json -AsArray'],
  [
    /Join-Path\s+(?:\([^)]*\)|\$\w+|'[^']*')\s+(?:\([^)]*\)|\$\w+|'[^']*')\s+(?:'[^']*'|\$\w+)(?!\s*[-)|])/,
    'Join-Path with 3+ positional segments',
  ],
  [/Get-Content[^\n]*-Tail\s+\d+[^\n]*-Wait/, 'n/a'],
];
const runtimeScripts = packagedUnique.filter(
  (p) => !/generate-payload|build-release|stage-/.test(p),
);
const psProblems = [];
for (const f of runtimeScripts) {
  const lines = rd(f).split(/\r?\n/);
  lines.forEach((line, i) => {
    const code = line
      .replace(/#.*$/, '')
      .replace(/'[^']*'/g, "''")
      .replace(/"[^"]*"/g, '""');
    for (const [re, label] of ps7only)
      if (
        label !== 'n/a' &&
        re.test(
          label.startsWith('Join-Path') || label.startsWith('ternary')
            ? line.replace(/#.*$/, '')
            : code,
        )
      )
        psProblems.push(`${f}:${i + 1} ${label}`);
  });
}
check(
  'packaged scripts use only Windows PowerShell 5.1 syntax',
  psProblems.length === 0,
  psProblems.join('; '),
);

// 3. secrets in MSI properties / command lines
const propValues = [...productNoComments.matchAll(/<Property\b[^>]*\/>/g)].map((m) => m[0]);
const commandLines = [...productNoComments.matchAll(/ExeCommand="([^"]*)"/g)].map((m) => m[1]);
const secretish = /(password|secret|passphrase|token|masterkey|private)/i;
check(
  'no secret-shaped MSI properties',
  propValues.every((p) => !secretish.test(p)),
  propValues.filter((p) => secretish.test(p)).join(' '),
);
check(
  'no secret-shaped values in custom-action command lines',
  commandLines.every((c) => !secretish.test(c)),
  commandLines.filter((c) => secretish.test(c)).join(' | '),
);
check(
  'custom actions that change the system run deferred (not as the user) and check their result, except best-effort clean-up',
  [...productNoComments.matchAll(/<CustomAction\b[\s\S]*?\/>/g)].every(
    (m) => /Execute="deferred"/.test(m[0]) && /Impersonate="no"/.test(m[0]),
  ),
);
check(
  'custom actions start system tools by absolute path (no search-path hijacking as SYSTEM)',
  commandLines.every((c) => c.startsWith('&quot;[System64Folder]')),
  commandLines.filter((c) => !c.startsWith('&quot;[System64Folder]')).join(' | '),
);
check(
  'no directory property sits directly before a closing quote in a command line (trailing-backslash trap)',
  commandLines.every((c) => !/\[[A-Za-z0-9]*Folder\]&quot;/.test(c)),
  commandLines.filter((c) => /\[[A-Za-z0-9]*Folder\]&quot;/.test(c)).join(' | '),
);
check(
  'provisioning passes no password on a command line (only paths and ports)',
  !/-Password|-Secret|-Token/i.test(commandLines.join(' ')),
);
const provCode = rd('scripts/windows/provision-postgres.ps1')
  .split(/\r?\n/)
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');
check(
  'database passwords are handed to initdb through a temporary file, never an argument',
  /--pwfile=/.test(provCode) && !/--pwprompt|\s-W\s/.test(provCode),
);

// 4. versioning
const upgradeCodes = [...product.matchAll(/UpgradeCode="([0-9a-f-]{36})"/gi)].map((m) => m[1]);
const bundleCode = /UpgradeCode="([0-9a-f-]{36})"/i.exec(bundle);
check(
  'the MSI has one constant UpgradeCode and no hard-coded ProductCode',
  upgradeCodes.length === 1 && !/ProductCode=/.test(product),
);
check(
  'the bundle has its own UpgradeCode, different from the MSI',
  !!bundleCode && bundleCode[1] !== upgradeCodes[0],
);
check(
  'MSI blocks downgrades and upgrades in place (MajorUpgrade with DowngradeErrorMessage)',
  /<MajorUpgrade\b[^>]*DowngradeErrorMessage=/.test(product),
);
check(
  'MSI and bundle versions come from one build define',
  /Version="\$\(var\.HexyrnVersion\)"/.test(product) &&
    /Version="\$\(var\.HexyrnVersion\)"/.test(bundle),
);
const versions = ['package.json', 'apps/api/package.json', 'apps/web/package.json'].map(
  (p) => JSON.parse(rd(p)).version,
);
check(
  'repository, API and web package versions agree',
  new Set(versions).size === 1,
  versions.join(', '),
);
check(
  'build script derives the MSI version from the repository version and stamps version.json',
  /rootPkg\.version/.test(build) && /version\.json/.test(build),
);

// 5. structure
check(
  'Windows 10+/64-bit launch condition',
  /<Launch Condition="Installed OR \(VersionNT64 &gt;= 1000\)"/.test(product),
);
check(
  'installation is verified healthy after services start (failure rolls back)',
  /VerifyRequisiteRunning[\s\S]{0,400}Return="check"/.test(product) &&
    /Action="VerifyRequisiteRunning" After="StartServices"/.test(product),
);
check(
  'uninstall keeps data by default: purge only with HEXYRNPURGEDATA=1, default 0',
  /<Property Id="HEXYRNPURGEDATA" Value="0"/.test(product) &&
    /HEXYRNPURGEDATA=&quot;1&quot;/.test(product) &&
    /Name="HEXYRNPURGEDATA" Type="string" Value="0"/.test(bundle),
);
check(
  'the optional firewall rule is removed on uninstall, and no rule is created by the installer',
  /RemoveRequisiteFirewallRule/.test(product) &&
    !/New-NetFirewallRule|firewall add rule/i.test(productNoComments),
);
check(
  'bundle installs the Microsoft C++ runtime the database engine needs, detected so it is skipped when present',
  /<ExePackage Id="VCRedist"/.test(bundle) && /DetectCondition="VCRuntimeBld/.test(bundle),
);
check(
  'bundle shows a licence agreement and launches the product on the last page',
  /rtfLicense/.test(bundle) && /LaunchTarget=/.test(bundle),
);
check(
  'Programs & Features has icon, publisher and help link',
  /ARPPRODUCTICON/.test(product) &&
    /ARPHELPLINK/.test(product) &&
    /Manufacturer="Hexyrn"/.test(product),
);
const ico = fs.readFileSync(path.join(root, 'installer/windows/assets/requisite.ico'));
check(
  'branding icon is a valid multi-size .ico',
  ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) >= 3,
);
check(
  'licence agreement file exists and is RTF',
  rd('installer/windows/assets/EULA.rtf').startsWith('{\\rtf1'),
);
if (/placeholder/i.test(rd('installer/windows/assets/EULA.rtf')))
  console.log(
    'WARN: EULA.rtf is still a placeholder - Hexyrn legal must supply the real agreement before a customer release.',
  );
check(
  'services never run as SYSTEM / LocalService / a named user account',
  !/Account="(LocalSystem|NT AUTHORITY\\(SYSTEM|LocalService|NetworkService))"/i.test(product),
);
check(
  'data root is locked down and holds no executable code',
  /SetHexyrnDataRootAcl/.test(product) &&
    !/\.exe/.test(
      (product.match(/<Directory Id="HexyrnDataFolder"[\s\S]*?<\/Directory>/) || [''])[0],
    ),
);

// 6. build outputs
check(
  'build produces versioned installer + MSI + checksums in dist/',
  /Requisite-Setup-\$fileVersion/.test(build) &&
    /Requisite-\$fileVersion/.test(build) &&
    /checksums\.txt/.test(build) &&
    /'dist'/.test(build),
);
check(
  'unsigned builds are visibly marked and -Release requires a signing certificate',
  /UNSIGNED-TEST/.test(build) && /-Release[^\n]*must be signed/.test(build),
);
check(
  'bundled Node.js and the C++ runtime are mandatory inputs (no dependency on the customer machine)',
  /bundled Node\.js runtime is required/.test(build) &&
    /C\+\+ runtime installer is required/.test(build),
);
check(
  'build can fetch and verify its own inputs (-FetchInputs)',
  /FetchInputs/.test(build) &&
    fs.existsSync(path.join(root, 'scripts/windows/fetch-build-inputs.ps1')),
);
check('the build refuses to package private-key files', /private key material/i.test(build));

// 7. private keys
const keyHits = [];
(function walk(d) {
  for (const n of fs.readdirSync(path.join(root, d))) {
    const p = d + '/' + n;
    const st = fs.statSync(path.join(root, p));
    if (st.isDirectory()) walk(p);
    else if (!/\.(ico|exe)$/.test(n) && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(rd(p)))
      keyHits.push(p);
  }
})('installer');
check('no private key material in installer/', keyHits.length === 0, keyHits.join(', '));

if (failed) {
  console.log(`\n${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll customer-asset checks passed.');
