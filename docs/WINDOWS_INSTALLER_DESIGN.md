# Windows Installer Design (P3 item 3)

**Status honestly stated up front:** this is design groundwork, not a
built or tested installer. `installer/windows/Product.wxs` is a real WiX
Toolset v4 source file that makes every concrete decision an installer
needs, but it has never been compiled (no WiX toolchain - `candle.exe`,
`light.exe`, `wix.exe` - is available in this development environment)
and there is no Windows GUI session available here to click through an
install/uninstall even if an `.msi` existed. Classify this as
**IMPLEMENTED-ENVIRONMENT-VERIFICATION-PENDING** for the design/source,
and **NOT IMPLEMENTED** for an actual working installer. See
`P3-ENVIRONMENT-VERIFICATION.md`'s "Windows installer" section.

## Why WiX Toolset v4

Chosen over NSIS/Inno Setup for one concrete reason: WiX produces a real
`.msi`, which integrates with Windows' own "Programs and Features"
uninstall list, group policy software deployment, and enterprise
patch-management tooling out of the box - relevant for a self-hosted
B2B product where an IT department, not an individual, may be the one
installing/updating it. NSIS/Inno Setup produce a bespoke `.exe`
installer that works fine for a single-user desktop app but doesn't get
the same enterprise-deployment integration for free.

## Packaging strategy: same build output as Docker

The installer packages `apps/api/dist` + `apps/api/node_modules` +
`packages/*/dist` - the exact same production build output
`apps/api/Dockerfile`'s runtime stage packages (see that Dockerfile's own
comments about the npm-workspace-symlink build-ordering bug found and
fixed this phase - the same build process applies here). Deliberately
one build pipeline, two distribution mechanisms, not a second
independently-maintained Windows build that could drift out of sync with
what's actually tested via Docker.

## Open decision: PostgreSQL bundling strategy - NOT YET DECIDED

This is the single biggest open question, and this document states it
plainly rather than picking an answer that hasn't been justified:

**Option A - require a pre-installed PostgreSQL** (matching the existing
Docker/native deployment model: the operator installs PostgreSQL 17
themselves, per `docs/DOCKER_DEPLOYMENT.md`'s role-creation script
pattern, and the Windows installer only sets up the Hexyrn Core
application + Windows Service). Pros: one database-setup story across
every deployment method (Docker, native Linux, Windows), reuses
`docker/postgres-init/01-app-role.sh`'s exact role logic (translated to
a `.bat`/`.ps1` equivalent run against the operator's own PostgreSQL
instance). Cons: a materially higher first-run bar for a non-technical
Windows operator - "go install PostgreSQL 17 first" is a real barrier
this product's stated audience (self-hosted, not necessarily
DBA-staffed) may not clear easily.

**Option B - bundle an embedded/portable PostgreSQL** (e.g. via the
official Windows PostgreSQL zip distribution, installed silently
alongside the app, running as its own Windows Service scoped to this
installation only). Pros: genuinely one-click install matching what a
non-technical operator expects. Cons: Hexyrn becomes responsible for
PostgreSQL's own security patching cadence on every customer's machine
(a real, ongoing operational commitment, not a one-time packaging
choice); doubles the amount of Windows-service lifecycle code this
installer needs to get right (two services to start/stop/upgrade in the
correct order, not one).

**This document does not resolve that choice** - it requires a product
decision (how technical is the actual first-customer audience,
realistically) that belongs with the coordinator/user, not something to
default silently inside a Dockerfile or a WiX source file. `Product.wxs`
above is written so either answer only changes what's harvested into
`ApiFiles`/whether a second `ServiceInstall` is added - the install
location, service registration pattern for the app itself, and
uninstall-data-retention design below are unaffected by which way this
goes.

## Windows Service account

`Product.wxs` currently uses `Account="LocalSystem"` as a conservative
placeholder that is guaranteed to work everywhere. A real release should
use a dedicated least-privilege service account instead (matching the
same "don't run as more-privileged than necessary" reasoning already
applied to `hexyrn_app`/`hexyrn_backup`'s restricted Postgres roles, and
to `apps/api/Dockerfile`'s non-root container user) - not finalized here
because the right mechanism (a machine-local service account created by
the installer vs. requiring the operator to supply one via Active
Directory in an enterprise deployment) depends on the PostgreSQL
bundling decision above.

## Uninstall / data retention

Mirrors `scripts/uninstall-docker.sh`'s design (see
`docs/OPERATOR_GUIDE.md` §15), not reinvented separately: removing the
application must not silently delete `storage/`, `backups/`, or
`config/` under `%ProgramData%\Hexyrn Core` unless the operator
explicitly says so a second time. A bare WiX `.msi` cannot show that kind
of confirmation dialog sequence on its own - this needs a WiX Burn
bundle (a small bootstrapper EXE wrapping the MSI) with a custom UI
sequence, which is real, additional design work deferred until the
PostgreSQL bundling decision is made (it directly affects what the
"delete data" confirmation needs to ask about - one database or two).

## What's needed to actually close this item

1. A product decision on the PostgreSQL bundling question above.
2. A real Windows machine with the WiX Toolset v4 installed
   (`dotnet tool install --global wix`) to compile `Product.wxs`,
   harvest the real `apps/api/dist`/`node_modules` file list (via `wix
   build`'s directory harvesting, not hand-enumeration), and iterate
   until it actually installs, starts the service, and uninstalls
   cleanly.
3. A WiX Burn bundle for the uninstall confirmation UI described above.
4. Real testing on a clean Windows VM (see the clean-machine acceptance
   test's still-open Windows-specific steps in
   `P3-ENVIRONMENT-VERIFICATION.md`).
