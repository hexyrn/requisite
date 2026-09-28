# The support bundle must never carry passwords, tokens or connection-string credentials.
$ErrorActionPreference = 'Stop'
$src = Get-Content (Join-Path $PSScriptRoot '..\Get-SupportBundle.ps1') -Raw
Invoke-Expression ([regex]::Match($src, 'function Protect-Text.*?\n}\n', 'Singleline').Value)
$cases = @{
    'connect postgres://hexyrn_app:SuperSecret123@127.0.0.1:5432/db failed' = 'SuperSecret123'
    'password=hunter2 user=bob'                                                 = 'hunter2'
    '{"token": "abcDEF123"}'                                                    = 'abcDEF123'
    'Authorization: Bearer sekrit-value'                                       = 'sekrit-value'
    'code abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ done'                    = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
}
foreach ($k in $cases.Keys) {
    if ((Protect-Text $k) -like "*$($cases[$k])*") { throw "FAIL: leaked '$($cases[$k])' from: $k" }
}
if ((Protect-Text 'normal line about requisitions') -ne 'normal line about requisitions') { throw 'FAIL: over-redacted a normal line' }
Write-Host 'PASS: support bundle redaction'
