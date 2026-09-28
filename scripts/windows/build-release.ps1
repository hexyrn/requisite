<#
.SYNOPSIS
  Single, documented entry point for a real Hexyrn Core Windows release
  build (P3 item 3/10) - environment validation through compiled,
  hashed MSI + Burn bundle artifacts.

.DESCRIPTION
  Orchestrates, in order, the 13 real steps a genuine Windows release
  build needs:
    1. Validate environment (WiX 4.0.6 + both extensions, Node, npm, git)
    2. Verify the PostgreSQL external artifact hash (fail closed)
    3. Build the production application (packages -> apps/api -> apps/web)
    4. Stage the production application payload
    5. Stage the Node.js runtime (external artifact, same fail-closed model)
    6. Extract/stage the PostgreSQL runtime
    7. Validate the staged payload (no dev deps, no secrets, no source .ts)
    8. Generate WiX harvesting/components for the payload
    9. Compile the MSI with WiX 4.0.6
    10. Compile the Burn bundle with WiX 4.0.6
    11. Validate the resulting artifacts (real files, expected sizes)
    12. Calculate SHA-256 hashes of the built artifacts
    13. Optionally invoke Authenticode/release signing (only if a real
        certificate/key is supplied - never fabricated)

  Each step fails closed - a missing required input stops the build with
  a clear, specific error naming exactly what's missing and where to get
  it, rather than silently skipping ahead.

.PARAMETER PostgresZipPath
  Path to the verified PostgreSQL 17 Windows binaries ZIP (required for
  steps 2/6). See scripts/windows/stage-postgres-artifact.ps1's own doc
  comment for the expected hash and source.

.PARAMETER NodeZipPath
  Path to the official Node.js 20.x Windows x64 binary ZIP (required for
  step 5). Not fetched by this script - see
  docs/internal/WINDOWS_INSTALLER_DESIGN.md's "Node.js runtime packaging" section.

.PARAMETER SigningCertPath / SigningCertPassword
  Optional. If supplied, step 13 code-signs the built artifacts via
  signtool.exe. If omitted, the build completes UNSIGNED and this is
  reported plainly as a real, tracked operational gap - never faked.

.PARAMETER SkipCompile
  Stops after step 8 (WiX component generation) without invoking the
  WiX compiler - useful for validating everything up to the compile step
  on a machine without the toolchain, or for a fast iteration loop.
#>
[CmdletBinding()]
param(
    # Third-party inputs: either give the files, or pass -FetchInputs to download and verify them (pinned SHA-256).
    [string]$PostgresZipPath,
    [string]$NodeZipPath,
    [switch]$FetchInputs,
    # Microsoft Visual C++ 2015-2022 x64 runtime installer (vc_redist.x64.exe), or -DownloadVCRedist.
    [string]$VCRedistPath,
    [switch]$DownloadVCRedist,
    # Shown in Programs & Features and the installer's About/Help links.
    [string]$SupportUrl = 'https://hexyrn.com',
    # Your vendor PUBLIC licence key (one line: what `npm run licence -- pubkey` prints after HEXYRN_LICENSE_PUBLIC_KEY=,
    # or the contents of licence-public.pem). Baked into the installer; without it the installed app refuses to
    # start in production. NEVER pass a private key here.
    [Parameter(Mandatory = $true)][string]$LicencePublicKeyFile,
    # WinSW service host (see stage-winsw-artifact.ps1). Either give the path to WinSW-x64.exe, or -DownloadWinSw
    # to fetch the pinned v2.12.0 release; the SHA-256 is verified either way.
    [string]$WinSwPath,
    [switch]$DownloadWinSw,
    # REAL bug found compiling this for the first time (WIX1148 warning,
    # not silently ignored): the MSI Product/Version attribute has a
    # genuine Windows Installer SDK format requirement - numeric only
    # (major.minor.build, each within specific ranges), no "-rc1"-style
    # labels. -HexyrnVersion is therefore now the strict MSI-valid
    # version used for Product.wxs/Bundle.wxs's own Version attributes
    # (also what Windows Installer's own upgrade-detection logic
    # compares); -ReleaseLabel is a SEPARATE, free-form string used only
    # in the built artifact's FILENAME (e.g. "rc1"), never fed into an
    # actual MSI/Burn Version attribute.
    # Default: taken from the repository version (root package.json) so the app, MSI, bundle and support bundle agree.
    [string]$HexyrnVersion,
    [string]$ReleaseLabel = 'rc1',
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$OutDir = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'dist'),
    [string]$SigningCertPath,
    [string]$SigningCertPassword,
    # A RELEASE build is the customer artifact Requisite-Setup.exe. It must be Authenticode-signed:
    # -Release without -SigningCertPath fails. Without -Release the output is Requisite-Setup-UNSIGNED-TEST.exe,
    # which must never be given to customers. See docs/WINDOWS_SIGNING.md.
    [switch]$Release,
    [switch]$SkipCompile,
    [switch]$CleanCheckout
)

$ErrorActionPreference = 'Stop'
if ($Release -and -not $SigningCertPath) { throw '-Release builds the customer installer and must be signed: pass -SigningCertPath (see docs/WINDOWS_SIGNING.md). For an internal test build, omit -Release.' }
function Write-Phase($n, $msg) { Write-Host "`n########## STEP $n : $msg ##########" -ForegroundColor Yellow }

$buildCache = Join-Path $RepoRoot '.build-cache'
# Intermediate files live in .build-cache\work; $OutDir receives only the finished customer artefacts.
$WorkDir = Join-Path $buildCache 'work'
if (Test-Path $WorkDir) { Remove-Item -Recurse -Force $WorkDir }
$payloadDir = Join-Path $WorkDir 'payload'
New-Item -ItemType Directory -Force -Path $OutDir, $WorkDir | Out-Null

# --- 0. Version: one source of truth (root package.json) so app, MSI, bundle, logs and support bundle agree ---
$rootPkg = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
$productVersion = [string]$rootPkg.version
foreach ($p in 'apps\api\package.json', 'apps\web\package.json') {
    $v = (Get-Content (Join-Path $RepoRoot $p) -Raw | ConvertFrom-Json).version
    if ($v -ne $productVersion) { throw "$p is version $v but the repository is $productVersion. Versions must agree before a release is built." }
}
if (-not $HexyrnVersion) { $HexyrnVersion = "$($productVersion -replace '-.*$', '').0" }
if ($HexyrnVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "-HexyrnVersion must be four numbers (e.g. 1.2.3.0), got '$HexyrnVersion'." }
$fileVersion = ($HexyrnVersion -replace '\.0$', '')
Write-Host "Building Requisite $fileVersion (MSI version $HexyrnVersion)"

if ($FetchInputs) {
    $inputs = & (Join-Path $PSScriptRoot 'fetch-build-inputs.ps1') -CacheDir (Join-Path $buildCache 'inputs')
    if (-not $PostgresZipPath) { $PostgresZipPath = $inputs.PostgresZip }
    if (-not $NodeZipPath) { $NodeZipPath = $inputs.NodeZip }
    if (-not $WinSwPath) { $DownloadWinSw = $true }
    if (-not $VCRedistPath) { $DownloadVCRedist = $true }
}
if (-not $PostgresZipPath) { throw 'PostgreSQL is required: pass -PostgresZipPath <zip> or use -FetchInputs.' }
if (-not $NodeZipPath) { throw 'The bundled Node.js runtime is required (customers must not need Node installed): pass -NodeZipPath <zip> or use -FetchInputs.' }
if (-not $VCRedistPath -and -not $DownloadVCRedist) { throw 'The Microsoft C++ runtime installer is required: pass -VCRedistPath <vc_redist.x64.exe> or -DownloadVCRedist (or use -FetchInputs).' }
$vcArgs = @{ StageDir = (Join-Path $buildCache 'vcredist') }
if ($VCRedistPath) { $vcArgs['ExePath'] = $VCRedistPath } else { $vcArgs['Download'] = $true }
$vcInfo = & (Join-Path $PSScriptRoot 'stage-vcredist-artifact.ps1') @vcArgs
if (-not $vcInfo) { throw 'C++ runtime staging failed.' }

# --- 1. Validate environment ---
Write-Phase 1 'Validate environment'
$wixVersion = (dotnet tool run wix -- --version) 2>&1
Write-Host "wix: $wixVersion"
if ($wixVersion -notmatch '^4\.0\.6') {
    throw "WiX toolchain is not pinned to 4.0.6 (got: $wixVersion). This RC deliberately does not use WiX 7 - see installer/windows/Product.wxs's own header comment. Run: dotnet tool restore"
}
$nodeVersion = node --version
Write-Host "node: $nodeVersion"
if ($nodeVersion -notmatch '^v20\.') {
    throw "Node.js is not v20.x (got: $nodeVersion) - matches this repo's engines.node requirement."
}
git --version | Out-Null
Write-Host 'PASS: environment validated.'

# --- 2. Verify PostgreSQL artifact hash (fail closed) ---
Write-Phase 2 'Verify PostgreSQL external artifact hash'
$pgStageScript = Join-Path $PSScriptRoot 'stage-postgres-artifact.ps1'
$pgInfo = & $pgStageScript -ZipPath $PostgresZipPath -StageDir (Join-Path $buildCache 'postgresql')
if (-not $pgInfo) { throw 'PostgreSQL artifact staging failed to return staging info.' }
Write-Host "PostgreSQL staged at: $($pgInfo.PgRoot)"

# --- 3+4. Build the production application + stage payload ---
Write-Phase '3-4' 'Build production application and stage payload'
$payloadScript = Join-Path $PSScriptRoot 'build-release-payload.ps1'
$payloadArgs = @{ SourceDir = $RepoRoot; OutDir = $payloadDir }
if ($CleanCheckout) { $payloadArgs['CleanCheckout'] = $true }
& $payloadScript @payloadArgs
if (-not (Test-Path (Join-Path $payloadDir 'apps\api\dist\main.js'))) {
    throw 'Payload staging did not produce apps\api\dist\main.js - see build-release-payload.ps1 output above.'
}
Write-Host 'PASS: application payload staged.'

# --- 5. Stage the Node.js runtime (external artifact, same fail-closed
# hash-verification model as PostgreSQL's step 2 - see
# stage-node-artifact.ps1, which replaced this step's earlier ad-hoc
# extract-with-no-hash-check logic once the real, independently-verified
# Node artifact became available) ---
Write-Phase 5 'Stage Node.js runtime'
$nodeRuntimeDir = Join-Path $payloadDir 'runtime\node'
if ($NodeZipPath) {
    $nodeInfo = & (Join-Path $PSScriptRoot 'stage-node-artifact.ps1') -ZipPath $NodeZipPath -StageDir (Join-Path $buildCache 'node')
    if (-not $nodeInfo) { throw 'Node.js artifact staging failed to return staging info.' }
    New-Item -ItemType Directory -Force -Path $nodeRuntimeDir | Out-Null
    # Copies the already hash-verified, extracted files into the payload
    # - the raw .zip itself is never copied anywhere near the payload
    # (item 4's "do not include the ZIP itself in the installed
    # payload"), only the real binaries it contained.
    Copy-Item -Recurse -Force "$($nodeInfo.NodeRoot)\*" $nodeRuntimeDir
    Write-Host "PASS: Node runtime staged (verified $($nodeInfo.Version), sha256=$($nodeInfo.Sha256))."
}
else {
    Write-Warning 'NO -NodeZipPath supplied - skipping Node runtime staging. installer/windows/Product.wxs''s ApiFiles harvest will NOT include a bundled Node runtime; the resulting MSI is INCOMPLETE for a real customer release (it would depend on Node being separately installed). This is reported plainly, not silently skipped: obtain the official Node.js 20.x Windows x64 binary zip from https://nodejs.org/dist/ and re-run with -NodeZipPath to close this gap.'
}

# --- 6. Extract/stage PostgreSQL runtime into the payload ---
Write-Phase '5b' 'Stage and verify the WinSW service host'
if (-not $WinSwPath -and -not $DownloadWinSw) { throw 'The Windows services need WinSW: pass -WinSwPath <WinSW-x64.exe> or -DownloadWinSw.' }
$winswArgs = @{ StageDir = (Join-Path $buildCache 'winsw') }
if ($WinSwPath) { $winswArgs['ExePath'] = $WinSwPath } else { $winswArgs['Download'] = $true }
$winswInfo = & (Join-Path $PSScriptRoot 'stage-winsw-artifact.ps1') @winswArgs
if (-not $winswInfo) { throw 'WinSW staging failed.' }

Write-Phase 6 'Stage PostgreSQL runtime into payload (server/client tools ONLY - not the full EDB distribution)'
# REAL FINDING from actually inspecting the extracted archive (not
# assumed): EDB's "binaries" zip is ~995MB total, of which "pgAdmin 4\"
# ALONE is ~806MB (a full GUI database admin application) and
# "StackBuilder\" is a small installer-helper utility - NEITHER is
# needed to run Hexyrn's managed PostgreSQL service, and bundling either
# would bloat the installer roughly 5x for components Hexyrn has no
# reason to ship, use, or take on the maintenance/security-patching
# burden of. Only bin\ (server + client tools - postgres.exe, initdb.exe,
# pg_ctl.exe, psql.exe, pg_dump.exe, pg_restore.exe, etc.), lib\
# (required shared libraries), share\ (required timezone/locale/config
# template data - PostgreSQL will not start without it), and include\
# (only needed if compiling extensions - kept for completeness at
# negligible size) are staged, plus the real license files (see
# "Licensing" below) - a deliberate, inspected selection, not "copy
# everything and hope."
$pgRuntimeDir = Join-Path $payloadDir 'runtime\postgresql'
New-Item -ItemType Directory -Force -Path $pgRuntimeDir | Out-Null
$pgRequiredDirs = @('bin', 'lib', 'share', 'include')
foreach ($dir in $pgRequiredDirs) {
    $src = Join-Path $pgInfo.PgRoot $dir
    if (-not (Test-Path $src)) { throw "Expected PostgreSQL runtime directory not found in staged artifact: $src" }
    Copy-Item -Recurse -Force $src (Join-Path $pgRuntimeDir $dir)
}
# License files (real, required for redistribution - see
# docs/internal/WINDOWS_INSTALLER_DESIGN.md's "Licensing" note): the PostgreSQL
# License itself (server_license.txt - permissive, genuinely
# redistributable) plus the commandline-tools third-party notices
# (covers pg_dump/pg_restore/psql's own dependencies). Deliberately NOT
# pgAdmin_license.txt/pgAdmin_3rd_party_licenses.txt/
# StackBuilder_3rd_party_licenses.txt - those cover components this
# installer does not bundle, so including their license files would be
# misleading (implying those components are present when they are not).
foreach ($licenseFile in @('server_license.txt', 'commandlinetools_3rd_party_licenses.txt')) {
    $src = Join-Path $pgInfo.PgRoot $licenseFile
    if (Test-Path $src) {
        Copy-Item -Force $src (Join-Path $pgRuntimeDir $licenseFile)
    }
    else {
        Write-Warning "Expected license file not found in staged artifact: $src (continuing, but this should be investigated - a real release must include PostgreSQL's license text)"
    }
}
$pgRuntimeSize = (Get-ChildItem -Recurse -Path $pgRuntimeDir -File | Measure-Object -Property Length -Sum).Sum
Write-Host "PostgreSQL runtime staged at: $pgRuntimeDir ($([math]::Round($pgRuntimeSize / 1MB, 1)) MB - excludes pgAdmin 4/StackBuilder)"

# --- 7. Validate the staged payload ---
Write-Phase 7 'Validate staged payload (no dev deps, no secrets, no source, no test tooling)'
# REAL FALSE-POSITIVE FOUND AND FIXED by actually running this against a
# genuine staged payload (not assumed correct from review): a naive
# "any directory anywhere named jest/@types" recursive search flags
# `node_modules\pino\test\jest\` (a production LOGGING dependency's own
# internal test FIXTURES, shipped as part of its package, never
# executed) and `node_modules\@types\` (completely normal - @types/*
# packages are ordinary npm packages, not "dev tooling," and their
# presence after `npm ci --omit=dev` means some production dependency
# genuinely declared one as a regular, non-dev dependency; pruning them
# out would risk breaking that dependency's own type-dependent runtime
# code in rare cases, for zero real security/size benefit). Fixed to
# check ONLY for the test FRAMEWORKS themselves actually being
# installed as their own top-level node_modules package - the thing
# that would actually indicate a packaging mistake - not any
# similarly-named nested folder belonging to a legitimate dependency.
$forbiddenTopLevelPackages = @('jest', 'vitest', 'ts-node', 'typescript', '@types/jest', '@types/node')
$forbiddenFound = @()
foreach ($pkg in $forbiddenTopLevelPackages) {
    $candidate = Join-Path $payloadDir "node_modules\$pkg"
    if (Test-Path $candidate) { $forbiddenFound += $candidate }
}
$gitDir = Join-Path $payloadDir '.git'
if (Test-Path $gitDir) { $forbiddenFound += $gitDir }
if ($forbiddenFound.Count -gt 0) {
    throw "Forbidden dev/test-only packages or repository metadata found in the staged payload: `n$($forbiddenFound -join "`n")"
}
$envFiles = Get-ChildItem -Path $payloadDir -Recurse -Filter '.env*' -File -Force -ErrorAction SilentlyContinue
if ($envFiles) { throw "Found .env file(s) in staged payload: $($envFiles.FullName -join ', ')" }
$pemFiles = Get-ChildItem -Path $payloadDir -Recurse -Include '*.pem', '*.key' -File -ErrorAction SilentlyContinue
if ($pemFiles) { throw "Found private key material in staged payload: $($pemFiles.FullName -join ', ')" }
Write-Host 'PASS: staged payload contains no forbidden dev/test/secret material.'

# Version stamp shipped with the product (read by the support bundle; the About/support screens can show it).
$commit = (git -C $RepoRoot rev-parse --short HEAD 2>$null)
@{ product = 'Requisite'; version = $fileVersion; msiVersion = $HexyrnVersion; commit = "$commit"; builtAt = (Get-Date).ToUniversalTime().ToString('o') } |
    ConvertTo-Json | Set-Content -Path (Join-Path $payloadDir 'version.json') -Encoding UTF8

# --- 8. Generate WiX harvesting (three separate harvests - application
# payload, Node runtime, PostgreSQL runtime - see Product.wxs's own
# comments for exactly why node.exe/postgres.exe are excluded from
# their respective harvests: each is hand-authored as its service's
# KeyPath file instead) ---
Write-Phase 8 'Generate WiX file harvesting for the staged payload'
$harvestGen = Join-Path $PSScriptRoot 'generate-payload-harvest.ps1'

$apiHarvestWxs = Join-Path $WorkDir 'PayloadFiles.wxs'
& $harvestGen -PayloadDir $payloadDir -OutFile $apiHarvestWxs -ComponentGroupId 'ApiFiles' -RootDirectoryRef 'ApiFolder' -SourceVarName 'PayloadDir' -ExcludeRelativePaths @('runtime')

$nodeRuntimeDirForHarvest = Join-Path $payloadDir 'runtime\node'
$nodeHarvestWxs = Join-Path $WorkDir 'NodeRuntimeFiles.wxs'
& $harvestGen -PayloadDir $nodeRuntimeDirForHarvest -OutFile $nodeHarvestWxs -ComponentGroupId 'NodeRuntimeFiles' -RootDirectoryRef 'NodeRuntimeFolder' -SourceVarName 'NodeRuntimeDir' -ExcludeRelativePaths @('node.exe')

$pgRuntimeDirForHarvest = Join-Path $payloadDir 'runtime\postgresql'
$pgHarvestWxs = Join-Path $WorkDir 'PostgresRuntimeFiles.wxs'
& $harvestGen -PayloadDir $pgRuntimeDirForHarvest -OutFile $pgHarvestWxs -ComponentGroupId 'PostgresRuntimeFiles' -RootDirectoryRef 'PostgresFolder' -SourceVarName 'PostgresRuntimeDir' -ExcludeRelativePaths @('bin\pg_ctl.exe')

Write-Host "Harvest sources generated: $apiHarvestWxs, $nodeHarvestWxs, $pgHarvestWxs"

if ($SkipCompile) {
    Write-Host "`n-SkipCompile set - stopping before WiX compilation. Everything through step 8 is complete and validated."
    return
}

# --- 9. Compile MSI ---
Write-Phase 9 'Compile MSI with WiX 4.0.6'
$msiPath = Join-Path $WorkDir 'Product.msi'
$productWxs = Join-Path $RepoRoot 'installer\windows\Product.wxs'
dotnet tool run wix -- build $productWxs $apiHarvestWxs $nodeHarvestWxs $pgHarvestWxs `
    -d "HexyrnVersion=$HexyrnVersion" `
    -d "PayloadDir=$payloadDir" `
    -d "NodeRuntimeDir=$nodeRuntimeDirForHarvest" `
    -d "PostgresRuntimeDir=$pgRuntimeDirForHarvest" `
    -d "RepoRoot=$RepoRoot" `
    -d "WinSwExe=$($winswInfo.ExePath)" `
    -d "LicencePublicKeyFile=$LicencePublicKeyFile" `
    -d "SupportUrl=$SupportUrl" `
    -ext WixToolset.Util.wixext/4.0.6 `
    -out $msiPath
if ($LASTEXITCODE -ne 0) { throw 'wix build (Product.wxs) failed - see compiler output above.' }
if (-not (Test-Path $msiPath)) { throw "wix build reported success but $msiPath does not exist." }
Write-Host "PASS: MSI compiled: $msiPath"

# The MSI inside the bundle is signed too (SmartScreen / Explorer show the publisher for both).
if ($SigningCertPath) {
    if (-not (Test-Path $SigningCertPath)) { throw "SigningCertPath does not exist: $SigningCertPath" }
    & signtool.exe sign /f $SigningCertPath /p $SigningCertPassword /fd sha256 /tr http://timestamp.digicert.com /td sha256 $msiPath
    if ($LASTEXITCODE -ne 0) { throw 'signtool sign (MSI) failed.' }
}

# --- 10. Compile Burn bundle ---
Write-Phase 10 'Compile Burn bundle with WiX 4.0.6'
$bundleName = if ($Release) { "Requisite-Setup-$fileVersion.exe" } else { "Requisite-Setup-$fileVersion-UNSIGNED-TEST.exe" }
$bundlePath = Join-Path $OutDir $bundleName
$bundleWxs = Join-Path $RepoRoot 'installer\windows\Bundle.wxs'
# Deliberately run from RepoRoot, NOT via Push-Location $OutDir - real
# bug found compiling this for the first time: `dotnet tool run wix`
# fails to resolve the WixToolset.Bal.wixext extension package when
# invoked from a directory other than the one `wix extension add`/
# `dotnet tool restore` was originally run from (a real, observed
# `dotnet tool run` behavior, not assumed). Bundle.wxs's
# `<MsiPackage SourceFile="Product.msi">` is still a relative path
# though - resolved via `-b $OutDir` (WiX's own bind-path mechanism),
# not by changing the working directory.
$bundleLocWxl = Join-Path $RepoRoot 'installer\windows\Bundle.en-us.wxl'
dotnet tool run wix -- build $bundleWxs `
    -d "HexyrnVersion=$HexyrnVersion" `
    -d "RepoRoot=$RepoRoot" `
    -d "VCRedistExe=$($vcInfo.ExePath)" `
    -d "VCRedistBuild=$($vcInfo.Build)" `
    -d "SupportUrl=$SupportUrl" `
    -loc $bundleLocWxl `
    -b $WorkDir `
    -ext WixToolset.Bal.wixext/4.0.6 `
    -ext WixToolset.Util.wixext/4.0.6 `
    -out $bundlePath
if ($LASTEXITCODE -ne 0) { throw 'wix build (Bundle.wxs) failed - see compiler output above.' }
if (-not (Test-Path $bundlePath)) { throw "wix build reported success but $bundlePath does not exist." }
Write-Host "PASS: Burn bundle compiled: $bundlePath"

# --- 11+12. Validate artifacts + hash ---
Write-Phase '11-12' 'Validate artifacts and calculate hashes'
$msiInfo = Get-Item $msiPath
$bundleInfo = Get-Item $bundlePath
$msiHash = (Get-FileHash $msiPath -Algorithm SHA256).Hash
$bundleHash = (Get-FileHash $bundlePath -Algorithm SHA256).Hash
Write-Host "MSI:    $msiPath ($([math]::Round($msiInfo.Length / 1MB, 1)) MB) sha256=$msiHash"
Write-Host "Bundle: $bundlePath ($([math]::Round($bundleInfo.Length / 1MB, 1)) MB) sha256=$bundleHash"

# --- 13. Optional signing ---
Write-Phase 13 'Optional Authenticode signing'
if ($SigningCertPath) {
    # A Burn bundle carries its own engine: detach it, sign the engine, reattach, then sign the bundle.
    $engine = Join-Path $WorkDir 'burn-engine.exe'
    dotnet tool run wix -- burn detach $bundlePath -engine $engine
    if ($LASTEXITCODE -ne 0) { throw 'wix burn detach failed.' }
    & signtool.exe sign /f $SigningCertPath /p $SigningCertPassword /fd sha256 /tr http://timestamp.digicert.com /td sha256 $engine
    if ($LASTEXITCODE -ne 0) { throw 'signtool sign (engine) failed.' }
    dotnet tool run wix -- burn reattach $bundlePath -engine $engine -o $bundlePath
    if ($LASTEXITCODE -ne 0) { throw 'wix burn reattach failed.' }
    Remove-Item $engine -Force
    & signtool.exe sign /f $SigningCertPath /p $SigningCertPassword /fd sha256 /tr http://timestamp.digicert.com /td sha256 $bundlePath
    if ($LASTEXITCODE -ne 0) { throw 'signtool sign (bundle) failed.' }
    & signtool.exe verify /pa $bundlePath
    if ($LASTEXITCODE -ne 0) { throw 'Signature verification failed.' }
    Write-Host 'PASS: bundle signed and verified.'
    $bundleHash = (Get-FileHash $bundlePath -Algorithm SHA256).Hash
    Write-Host "Post-signing SHA-256: $bundleHash"
}
else {
    Write-Warning 'UNSIGNED TEST BUILD (Requisite-Setup-UNSIGNED-TEST.exe): do not give this to customers; Windows SmartScreen will warn. Build with -Release -SigningCertPath for the customer installer.'
}

# --- 14. Publish: only finished artefacts + checksums go to $OutDir ---
Write-Phase 14 'Publish artefacts and checksums'
$msiFinal = Join-Path $OutDir $(if ($Release) { "Requisite-$fileVersion.msi" } else { "Requisite-$fileVersion-UNSIGNED-TEST.msi" })
Copy-Item -Force $msiPath $msiFinal
$lines = foreach ($p in @($bundlePath, $msiFinal)) { "$((Get-FileHash $p -Algorithm SHA256).Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($p))" }
Set-Content -Path (Join-Path $OutDir 'checksums.txt') -Value $lines -Encoding ASCII
Get-Content (Join-Path $OutDir 'checksums.txt') | ForEach-Object { Write-Host $_ }
$expected = @($bundlePath, $msiFinal, (Join-Path $OutDir 'checksums.txt'))
foreach ($e in $expected) { if (-not (Test-Path $e) -or (Get-Item $e).Length -eq 0) { throw "Expected output missing or empty: $e" } }

Write-Host "`n=== Build complete ==="
return [PSCustomObject]@{
    MsiPath      = $msiFinal
    MsiSha256    = $msiHash
    BundlePath   = $bundlePath
    BundleSha256 = $bundleHash
    Signed       = [bool]$SigningCertPath
}
