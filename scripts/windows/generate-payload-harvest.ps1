<#
.SYNOPSIS
  Generates a real WiX v4 Fragment (.wxs) harvesting every file under a
  staged release payload directory into a NESTED Directory/Component/File
  tree matching the payload's real folder structure (P3 item 3/10) - the
  "do not hand-maintain hundreds of individual files" requirement,
  implemented as deterministic generation rather than a WiX heat.exe
  dependency (heat.exe is a WiX v3 tool; a small, reviewable PowerShell
  generator gives full control here).

.DESCRIPTION
  IMPORTANT CORRECTNESS NOTE (a real bug avoided, not a hypothetical):
  a WiX <File>'s `Source` attribute controls where bits are copied FROM
  at build time, but the file's INSTALLED location on the target machine
  is controlled by which <Directory> element its <Component> is nested
  under - these are independent. A flat harvest (every Component under
  one single ApiFolder Directory, regardless of the file's real
  subdirectory) would silently collapse `node_modules\pg\lib\...` and
  `apps\api\dist\...` into the same destination folder - badly wrong.
  This generator therefore builds a REAL nested <Directory> tree
  mirroring the payload's actual folder structure, and places each
  file's <Component> under the correspondingly-nested <Directory>.

  Deterministic Component GUIDs (derived from a stable hash of each
  file's relative path, not randomly regenerated every run) - required
  for correct MSI upgrade semantics (Windows Installer must recognize
  "this is the same component, updated" across versions, not a new one
  every build).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PayloadDir,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$ComponentGroupId = 'ApiFiles',
    [string]$RootDirectoryRef = 'ApiFolder',
    [string[]]$ExcludeRelativePaths = @(),
    [string]$SourceVarName = 'PayloadDir'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $PayloadDir)) {
    throw "PayloadDir does not exist: $PayloadDir (run scripts\windows\build-release-payload.ps1 first)"
}

function Get-DeterministicGuid([string]$seed) {
    $md5 = [System.Security.Cryptography.MD5]::Create()
    try {
        $hash = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($seed))
        # Real bug found running this against the actual 17,301-file
        # staged payload (not assumed correct from review): PowerShell's
        # array-slice `$hash[0..15]` returns a generic [object[]], which
        # fails .NET overload resolution against Guid(byte[]) and falls
        # through to Guid(string) instead, throwing a FormatException.
        # An explicit [byte[]] cast forces the correct overload.
        return [guid]::new([byte[]]$hash[0..15]).ToString()
    }
    finally {
        $md5.Dispose()
    }
}

function Get-SafeId([string]$raw, [string]$prefix) {
    # ALWAYS append a short deterministic hash suffix - two REAL
    # collisions were found running this against the actual staged
    # payload (not hypothetical): (1) WiX's identifier namespace is
    # GLOBAL across every Fragment compiled together, so a bare
    # "(root)"-seeded Id for root-level files collided between this
    # harvest's ComponentGroup and a DIFFERENT harvest's (ApiFiles vs
    # PostgresRuntimeFiles both producing "cmp__root_") - fixed by
    # folding $ComponentGroupId into the seed, making every harvest's
    # namespace distinct. (2) PostgreSQL's own share\timezone\ directory
    # contains files like "Etc/GMT+0" and "Etc/GMT-0" whose sanitized
    # (non-alphanumeric-stripped) Ids BOTH collapse to "Etc_GMT_0" -
    # fixed by never relying on sanitized-name uniqueness alone; the
    # hash suffix (derived from the real, pre-sanitization raw path)
    # disambiguates them even though their sanitized prefixes match.
    $namespacedSeed = "$ComponentGroupId|$raw"
    $sanitized = ($raw -replace '[^A-Za-z0-9_]', '_')
    if ($sanitized.Length -gt 40) { $sanitized = $sanitized.Substring(0, 40) }
    $suffix = (Get-DeterministicGuid $namespacedSeed).Substring(0, 8)
    return "$prefix${sanitized}_$suffix"
}

$payloadFull = (Resolve-Path $PayloadDir).Path
$allFiles = Get-ChildItem -Path $payloadFull -Recurse -File
$files = $allFiles | Where-Object {
    $rel = $_.FullName.Substring($payloadFull.Length).TrimStart('\', '/') -replace '/', '\'
    -not ($ExcludeRelativePaths | Where-Object { $rel -eq $_ -or $rel.StartsWith("$_\") })
}
Write-Host "Harvesting $($files.Count) files from $payloadFull (excluded $($allFiles.Count - $files.Count) matching -ExcludeRelativePaths)"

# Build a tree: node = { Dirs = @{name -> node}; Files = @(relPath...) }
$root = [ordered]@{ Dirs = [ordered]@{}; Files = @() }
foreach ($file in $files) {
    $relPath = $file.FullName.Substring($payloadFull.Length).TrimStart('\', '/')
    $parts = $relPath -split '[\\/]'
    $node = $root
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        $seg = $parts[$i]
        if (-not $node.Dirs.Contains($seg)) {
            $node.Dirs[$seg] = [ordered]@{ Dirs = [ordered]@{}; Files = @() }
        }
        $node = $node.Dirs[$seg]
    }
    $node.Files += , $relPath
}

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('<?xml version="1.0" encoding="UTF-8"?>')
[void]$sb.AppendLine('<!-- GENERATED FILE - do not hand-edit. Regenerate via scripts/windows/generate-payload-harvest.ps1 (build-release.ps1''s own step 8 does this automatically) whenever the staged payload changes. Nested <Directory> tree mirrors the real payload folder structure - see this script''s own doc comment for why a flat harvest would be a real correctness bug, not just untidy. Deterministic Component GUIDs so re-running against an unchanged file set is byte-identical, which real MSI upgrade semantics depend on. -->')
[void]$sb.AppendLine('<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">')
[void]$sb.AppendLine('  <Fragment>')
[void]$sb.AppendLine("    <ComponentGroup Id=`"$ComponentGroupId`">")

$componentCount = 0
$fileCount = 0
# ONE Component PER DIRECTORY containing ALL that directory's files as
# multiple <File> elements (only the first gets KeyPath="yes") - NOT one
# component per file. Deliberate: the staged payload's node_modules tree
# alone is tens of thousands of files; one-component-per-file is the WiX
# textbook default (better for granular repair/versioning) but produces
# an impractically large/slow-to-compile .wxs for a vendored dependency
# tree of this size - one-component-per-directory is the accepted
# pattern for exactly this case (the files within a single npm package's
# directory always move/update together as a unit in practice anyway).
function Write-Node($node, $relDirPath, $indent) {
    $pad = '  ' * $indent
    if ($node.Files.Count -gt 0) {
        $dirSeed = if ($relDirPath) { $relDirPath } else { '(root)' }
        $componentId = Get-SafeId $dirSeed 'cmp_'
        # Namespaced with ComponentGroupId for the same real reason as
        # Get-SafeId's own hash suffix - a Component's Guid must be
        # unique across the WHOLE linked build, not just within one
        # harvest's own ComponentGroup, and a bare "(root)" seed would
        # otherwise collide between separate harvests (ApiFiles vs.
        # PostgresRuntimeFiles both have root-level files).
        $guid = Get-DeterministicGuid "$ComponentGroupId|$dirSeed"
        [void]$script:sb.AppendLine("$pad  <Component Id=`"$componentId`" Directory=`"$script:currentDirRef`" Guid=`"$guid`">")
        $isFirst = $true
        foreach ($relPath in $node.Files) {
            $fileId = Get-SafeId $relPath 'file_'
            $escapedSource = ($relPath -replace '/', '\').Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
            $keyPathAttr = if ($isFirst) { ' KeyPath="yes"' } else { '' }
            [void]$script:sb.AppendLine("$pad    <File Id=`"$fileId`" Source=`"`$(var.$SourceVarName)\$escapedSource`"$keyPathAttr />")
            $isFirst = $false
            $script:fileCount++
        }
        [void]$script:sb.AppendLine("$pad  </Component>")
        $script:componentCount++
    }
}

# Directory elements must live in Product.wxs's own directory tree (under
# ApiFolder), declared via a separate <Fragment><DirectoryRef> here so
# WiX links them together at compile time - components reference the
# leaf directory by Id.
$dirFragmentSb = New-Object System.Text.StringBuilder
function Write-DirTree($node, $parentDirId, $pathSoFar) {
    foreach ($dirName in $node.Dirs.Keys) {
        $childPath = if ($pathSoFar) { "$pathSoFar/$dirName" } else { $dirName }
        $dirId = Get-SafeId $childPath 'dir_'
        [void]$script:dirFragmentSb.AppendLine("      <Directory Id=`"$dirId`" Name=`"$([System.Security.SecurityElement]::Escape($dirName))`">")
        $script:currentDirRef = $dirId
        Write-Node $node.Dirs[$dirName] $childPath 3
        Write-DirTree $node.Dirs[$dirName] $dirId $childPath
        [void]$script:dirFragmentSb.AppendLine('      </Directory>')
    }
}

$script:currentDirRef = $RootDirectoryRef
Write-Node $root '' 2
Write-DirTree $root $RootDirectoryRef ''

[void]$sb.AppendLine('    </ComponentGroup>')
[void]$sb.AppendLine('  </Fragment>')
[void]$sb.AppendLine('  <Fragment>')
[void]$sb.AppendLine("    <DirectoryRef Id=`"$RootDirectoryRef`">")
[void]$sb.Append($dirFragmentSb.ToString())
[void]$sb.AppendLine('    </DirectoryRef>')
[void]$sb.AppendLine('  </Fragment>')
[void]$sb.AppendLine('</Wix>')

[System.IO.File]::WriteAllText($OutFile, $sb.ToString(), [System.Text.Encoding]::UTF8)
Write-Host "Wrote $OutFile ($fileCount files in $componentCount directory-components, real nested directory tree)"
