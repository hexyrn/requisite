<#
.SYNOPSIS
  Stages the real production application payload for the Windows installer
  (P3 item 3/4) into a clean, reproducible directory - NOT the developer's
  own working tree, and NOT the full development node_modules.

.DESCRIPTION
  This is the Windows-installer equivalent of apps/api/Dockerfile's
  multi-stage build: it produces the SAME production artifact (compiled
  apps/api/dist, apps/web/dist, packages/*/dist, and a PRODUCTION-ONLY
  node_modules tree - no devDependencies, no test files, no source .ts)
  that the Docker image already ships, so the Windows and Docker
  distribution paths never silently diverge in what code actually runs.

  Deliberately builds into a FRESH CLONE under a clean workspace (default:
  $env:TEMP\hexyrn-release-build), not in place inside the developer's own
  repository checkout - see the -SourceDir/-CleanCheckout parameters and
  docs/WINDOWS_ACCEPTANCE_PREP.md's "OneDrive / clean build workspace"
  section for why: this repository currently lives under OneDrive, which
  has already caused a real `npm ci` EPERM lock (OneDrive's own file
  sync grabbing a lock on a file npm is mid-write to) and Docker
  Desktop file-sync errors on node_modules/.bin during this phase's own
  work. A release artifact must never depend on OneDrive's sync timing to
  build reproducibly.

.PARAMETER SourceDir
  The repository to build FROM. Defaults to the directory this script's
  own path implies (two levels up from scripts/windows/).

.PARAMETER OutDir
  Where the staged, clean production payload is written. Defaults to
  .\dist-release\payload under the CURRENT working directory (NOT under
  $SourceDir, so a re-run never mixes clean output back into the source
  tree).

.PARAMETER CleanCheckout
  If set, clones $SourceDir into a fresh temp directory via `git clone`
  first and builds FROM THAT clone, rather than building in place from a
  developer's own (possibly OneDrive-synced, possibly dirty) working
  tree. Strongly recommended for an actual release build - see
  docs/WINDOWS_ACCEPTANCE_PREP.md.

.EXAMPLE
  # Real release build, from a clean git clone, into .\dist-release\payload
  .\scripts\windows\build-release-payload.ps1 -CleanCheckout

.EXAMPLE
  # Fast local iteration against the current working tree (NOT for a real release artifact)
  .\scripts\windows\build-release-payload.ps1
#>
[CmdletBinding()]
param(
    [string]$SourceDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$OutDir = (Join-Path (Get-Location) 'dist-release\payload'),
    [switch]$CleanCheckout,
    [switch]$IAcknowledgeThisPrunesDevDependencies
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# REAL SAFETY GUARD, added after a genuine incident: running this script
# WITHOUT -CleanCheckout against a live development working tree runs
# `npm ci --omit=dev` IN PLACE, which strips typescript/eslint/jest/
# vitest/ts-node etc. out of the developer's own node_modules - this
# happened for real during this project's own Windows-installer work
# (build-release-payload.ps1 was run without -CleanCheckout, silently
# broke `npx tsc`/`npx eslint` in the live dev environment, and had to
# be recovered with a plain `npm ci`). Refuse outright unless the
# operator either uses -CleanCheckout (the safe, recommended path) or
# explicitly acknowledges the risk with -IAcknowledgeThisPrunesDevDependencies.
if (-not $CleanCheckout -and -not $IAcknowledgeThisPrunesDevDependencies) {
    throw "Refusing to build in place without -CleanCheckout - this WILL run 'npm ci --omit=dev' directly in $SourceDir and strip its devDependencies (a real incident, not a hypothetical one - see this script's own comment). Pass -CleanCheckout for a real, safe release build, or -IAcknowledgeThisPrunesDevDependencies if you specifically intend to prune this exact working tree's node_modules."
}

$buildRoot = $SourceDir
if ($CleanCheckout) {
    Write-Step 'Cloning a fresh checkout (bypasses OneDrive sync entirely for the build itself)'
    $cloneDir = Join-Path $env:TEMP ("hexyrn-release-build-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    git clone --local --no-hardlinks $SourceDir $cloneDir
    if ($LASTEXITCODE -ne 0) { throw "git clone failed against $SourceDir" }
    $buildRoot = $cloneDir
    Write-Host "Building from clean clone: $buildRoot"
}

Push-Location $buildRoot
try {
    Write-Step "Verifying git working tree is clean (a release build from uncommitted local changes is a real mistake class, not a hypothetical one)"
    $dirty = git status --porcelain
    if ($dirty -and -not $CleanCheckout) {
        Write-Warning "Working tree has uncommitted changes - this is fine for local iteration but NOT for a real release payload. Use -CleanCheckout for a real build."
    }

    Write-Step 'npm ci (exact lockfile versions, not a floating install)'
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }

    Write-Step 'Building every workspace (packages/shared-types, packages/app-sdk, packages/design-system, apps/api, apps/web)'
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }

    Write-Step 'Re-running the full verification suite against THIS build before packaging it (never trust a prior build/machine for the artifact being shipped)'
    npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
    npm run lint
    if ($LASTEXITCODE -ne 0) { throw 'lint failed' }

    Write-Step 'Installing PRODUCTION-ONLY dependencies into a separate prune pass (matches apps/api/Dockerfile: `npm ci --omit=dev` after the build, not before - devDependencies like typescript/ts-node/jest are needed to BUILD, not to RUN)'
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'npm ci --omit=dev failed' }

    if (Test-Path $OutDir) {
        Write-Step "Removing previous staged payload at $OutDir"
        Remove-Item -Recurse -Force $OutDir
    }
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

    Write-Step 'Staging the real production payload (mirrors apps/api/Dockerfile''s runtime stage COPY list exactly - see that Dockerfile for why each path is what it is)'
    $apiOut = Join-Path $OutDir 'apps\api'
    New-Item -ItemType Directory -Force -Path $apiOut | Out-Null
    Copy-Item -Recurse -Force (Join-Path $buildRoot 'apps\api\dist') (Join-Path $apiOut 'dist')
    Copy-Item -Force (Join-Path $buildRoot 'apps\api\package.json') (Join-Path $apiOut 'package.json')
    Copy-Item -Recurse -Force (Join-Path $buildRoot 'apps\api\src\db\migrations') (Join-Path $apiOut 'dist\db\migrations')

    Copy-Item -Recurse -Force (Join-Path $buildRoot 'apps\web\dist') (Join-Path $OutDir 'apps\web\dist')

    foreach ($pkg in @('shared-types', 'app-sdk')) {
        $pkgOut = Join-Path $OutDir "packages\$pkg"
        New-Item -ItemType Directory -Force -Path $pkgOut | Out-Null
        Copy-Item -Recurse -Force (Join-Path $buildRoot "packages\$pkg\dist") (Join-Path $pkgOut 'dist')
        Copy-Item -Force (Join-Path $buildRoot "packages\$pkg\package.json") (Join-Path $pkgOut 'package.json')
    }

    Write-Step 'Copying the hoisted PRODUCTION-ONLY node_modules (npm workspaces hoists to the repo root - see apps/api/Dockerfile''s own comment on this)'
    Copy-Item -Recurse -Force (Join-Path $buildRoot 'node_modules') (Join-Path $OutDir 'node_modules')
    # npm may nest some packages under apps/api/node_modules instead of hoisting them (same trap as
    # apps/api/Dockerfile: the installed service would die with "Cannot find module '@nestjs/core'").
    $nestedModules = Join-Path $buildRoot 'apps\api\node_modules'
    if (Test-Path $nestedModules) {
        Copy-Item -Recurse -Force $nestedModules (Join-Path $apiOut 'node_modules')
    }
    Copy-Item -Force (Join-Path $buildRoot 'package.json') (Join-Path $OutDir 'package.json')

    Write-Step 'Verifying no source .ts files, no devDependencies, and no dotfiles/secrets leaked into the staged payload'
    $strayTs = Get-ChildItem -Recurse -Path $OutDir -Filter '*.ts' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.Extension -eq '.ts' -and $_.FullName -notmatch '\.d\.ts$' }
    if ($strayTs) {
        throw "Found source .ts files in the staged payload (should be compiled .js only): $($strayTs.FullName -join ', ')"
    }
    $envFiles = Get-ChildItem -Recurse -Path $OutDir -Filter '.env*' -File -Force -ErrorAction SilentlyContinue
    if ($envFiles) {
        throw "Found .env file(s) in the staged payload - a real secret-leak risk: $($envFiles.FullName -join ', ')"
    }

    Write-Step "Payload staged successfully at $OutDir"
    Write-Host "  apps/api/dist/main.js exists: $(Test-Path (Join-Path $apiOut 'dist\main.js'))"
    Write-Host "  apps/web/dist/index.html exists: $(Test-Path (Join-Path $OutDir 'apps\web\dist\index.html'))"
    $nodeModulesSize = (Get-ChildItem -Recurse -Path (Join-Path $OutDir 'node_modules') -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    Write-Host "  node_modules size: $([math]::Round($nodeModulesSize / 1MB, 1)) MB (production-only)"
}
finally {
    Pop-Location
    if ($CleanCheckout -and $buildRoot -ne $SourceDir) {
        Write-Step "Leaving the clean clone in place for inspection: $buildRoot (delete manually when done)"
    }
}
