#!/usr/bin/env bash
# Compiles the real Product.wxs + Bundle.wxs (with harvest fragments produced by the real harvester from a tiny fake
# payload) using WiX 4.0.6, and fails on any genuine authoring error. On Linux, WiX cannot BIND (it expects Windows
# paths / MSI tables), so the only tolerated messages are the known path-binding artefacts below; everything else -
# unknown elements or attributes, unresolved references, duplicate ids, bad conditions - fails the check.
# --self-test additionally injects a deliberate defect and requires the filter to catch it (guards the filter itself).
# Needs: pwsh, dotnet (DOTNET_ROOT), wix 4.0.6 with Util + Bal extensions.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
WIX="${WIX:-$(command -v wix || echo /opt/wix/wix)}"; PWSH="${PWSH:-pwsh}"
export DOTNET_ROOT="${DOTNET_ROOT:-/opt/dotnet/lib/dotnet}" DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/payload/apps/api/dist" "$T/payload/apps/web/dist" "$T/node" "$T/pg/bin" "$T/pg/lib" "$T/repo-assets"
echo "x" > "$T/payload/apps/api/dist/main.js"; echo "x" > "$T/payload/apps/web/dist/index.html"
for f in node.exe; do echo x > "$T/node/$f"; done; echo x > "$T/node/README.md"
for f in postgres.exe pg_ctl.exe initdb.exe psql.exe pg_dump.exe pg_restore.exe; do echo x > "$T/pg/bin/$f"; done; echo x > "$T/pg/lib/x.dll"
echo x > "$T/WinSW.exe"; echo x > "$T/licence.txt"
H="$REPO/scripts/windows/generate-payload-harvest.ps1"
$PWSH -NoProfile -File "$H" -PayloadDir "$T/payload" -OutFile "$T/Api.wxs" -ComponentGroupId ApiFiles -RootDirectoryRef ApiFolder -SourceVarName PayloadDir >/dev/null || { echo "FAIL harvest api"; exit 1; }
$PWSH -NoProfile -File "$H" -PayloadDir "$T/node" -OutFile "$T/Node.wxs" -ComponentGroupId NodeRuntimeFiles -RootDirectoryRef NodeRuntimeFolder -SourceVarName NodeRuntimeDir -ExcludeRelativePaths node.exe >/dev/null || { echo "FAIL harvest node"; exit 1; }
$PWSH -NoProfile -File "$H" -PayloadDir "$T/pg" -OutFile "$T/Pg.wxs" -ComponentGroupId PostgresRuntimeFiles -RootDirectoryRef PostgresFolder -SourceVarName PostgresRuntimeDir -ExcludeRelativePaths 'bin\pg_ctl.exe' >/dev/null || { echo "FAIL harvest pg"; exit 1; }

# Known, Linux-only binder artefacts (Windows path separators / file existence). Nothing else is tolerated.
filter() { grep -v "only supports Windows" | grep -Ev "WIX0103|WIX0389|WIX0027" | grep -E "error|Error" ; }
compile_product() {
  "$WIX" build "${1:-$REPO/installer/windows/Product.wxs}" "$T/Api.wxs" "$T/Node.wxs" "$T/Pg.wxs" \
    -d HexyrnVersion=1.2.3.0 -d PayloadDir="$T/payload" -d NodeRuntimeDir="$T/node" -d PostgresRuntimeDir="$T/pg" \
    -d RepoRoot="$REPO" -d WinSwExe="$T/WinSW.exe" -d LicencePublicKeyFile="$T/licence.txt" -d SupportUrl=https://example.invalid \
    -ext WixToolset.Util.wixext/4.0.6 -o "$T/out.msi" 2>&1
}
compile_bundle() {
  echo x > "$T/Product.msi"; echo x > "$T/vc_redist.x64.exe"
  "$WIX" build "${1:-$REPO/installer/windows/Bundle.wxs}" -d HexyrnVersion=1.2.3.0 -d RepoRoot="$REPO" -d VCRedistExe="$T/vc_redist.x64.exe" -d VCRedistBuild=33135 -d SupportUrl=https://example.invalid \
    -loc "$REPO/installer/windows/Bundle.en-us.wxl" -b "$T" -ext WixToolset.Bal.wixext/4.0.6 -ext WixToolset.Util.wixext/4.0.6 -o "$T/out.exe" 2>&1
}
rc=0
out="$(compile_product)"; bad="$(echo "$out" | filter)"
if [ -n "$bad" ]; then echo "FAIL Product.wxs:"; echo "$bad"; rc=1; else echo "PASS Product.wxs compiles (no authoring errors)"; fi
out="$(compile_bundle)"; bad="$(echo "$out" | filter)"
if [ -n "$bad" ]; then echo "FAIL Bundle.wxs:"; echo "$bad"; rc=1; else echo "PASS Bundle.wxs compiles (no authoring errors)"; fi

node "$REPO/scripts/windows/__tests__/wix-reference-check.js" "$REPO/installer/windows/Product.wxs" "$T/Api.wxs" "$T/Node.wxs" "$T/Pg.wxs" || rc=1

if [ "${1:-}" = "--self-test" ]; then
  sed 's#<Property Id="HEXYRNPGPORT" Value="55432" />#<Property Id="HEXYRNPGPORT" Value="55432" /><NoSuchElement />#' "$REPO/installer/windows/Product.wxs" > "$T/Broken.wxs"
  out="$(compile_product "$T/Broken.wxs")"; bad="$(echo "$out" | filter)"
  [ -n "$bad" ] && echo "PASS self-test: a deliberate authoring defect is caught by the filter" || { echo "FAIL self-test: defect was NOT caught"; rc=1; }
  sed 's#<ComponentGroupRef Id="ApiFiles" />#<ComponentGroupRef Id="NoSuchGroup" />#' "$REPO/installer/windows/Product.wxs" > "$T/Broken2.wxs"
  node "$REPO/scripts/windows/__tests__/wix-reference-check.js" "$T/Broken2.wxs" "$T/Api.wxs" "$T/Node.wxs" "$T/Pg.wxs" >/dev/null 2>&1 && bad="" || bad="caught"
  [ -n "$bad" ] && echo "PASS self-test: an unresolved reference is caught" || { echo "FAIL self-test: unresolved reference NOT caught"; rc=1; }
  sed 's#<Component Id="LicenceKeyFile"#<Component Id="StartMenuShortcuts"#' "$REPO/installer/windows/Product.wxs" > "$T/Broken3.wxs"
  node "$REPO/scripts/windows/__tests__/wix-reference-check.js" "$T/Broken3.wxs" "$T/Api.wxs" "$T/Node.wxs" "$T/Pg.wxs" >/dev/null 2>&1 && { echo "FAIL self-test: duplicate id NOT caught"; rc=1; } || echo "PASS self-test: a duplicate Id is caught"
fi
exit $rc
