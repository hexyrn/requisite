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
        return [guid]::new($hash[0..15]).ToString()
    }
    finally {
        $md5.Dispose()
    }
}

function Get-SafeId([string]$raw, [string]$prefix) {
    $id = $prefix + ($raw -replace '[^A-Za-z0-9_]', '_')
    if ($id.Length -gt 68) {
        $id = $id.Substring(0, 55) + '_' + (Get-DeterministicGuid $raw).Substring(0, 8)
    }
    return $id
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
        $guid = Get-DeterministicGuid $dirSeed
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
