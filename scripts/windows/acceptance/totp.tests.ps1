# Get-Totp must agree with the RFC 6238 test vectors (secret "12345678901234567890", SHA-1, 6 digits).
. (Join-Path $PSScriptRoot 'RequisiteApi.ps1')
$secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
$vectors = @{ 59 = '287082'; 1111111109 = '081804'; 1111111111 = '050471'; 1234567890 = '005924'; 2000000000 = '279037' }
foreach ($t in $vectors.Keys) {
    $got = Get-Totp $secret $t
    if ($got -ne $vectors[$t]) { throw "FAIL TOTP at t=$t expected $($vectors[$t]) got $got" }
}
Write-Host 'PASS: TOTP matches RFC 6238 vectors'
