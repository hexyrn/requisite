# Tests for the settings-file helpers used by Enable-LanAccess.ps1.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\Hexyrn-Common.ps1')
$f = Join-Path ([IO.Path]::GetTempPath()) ("envtest-" + [guid]::NewGuid().ToString('N') + '.env')
Set-Content $f "PORT=3000`r`nHOST=127.0.0.1`r`nSECRET=abc=def"
Set-EnvFileValue $f 'HOST' '0.0.0.0'
Set-EnvFileValue $f 'NEW' 'x'
Remove-EnvFileValue $f 'PORT'
if ((Get-EnvFileValue $f 'HOST') -ne '0.0.0.0') { throw 'FAIL replace' }
if ((Get-EnvFileValue $f 'NEW') -ne 'x') { throw 'FAIL append' }
if ($null -ne (Get-EnvFileValue $f 'PORT')) { throw 'FAIL remove' }
if ((Get-EnvFileValue $f 'SECRET') -ne 'abc=def') { throw 'FAIL untouched value' }
Remove-Item $f
Write-Host 'PASS: env file helpers'
