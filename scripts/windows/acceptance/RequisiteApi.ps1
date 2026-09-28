# Small HTTP client + TOTP used by the acceptance harness (dot-sourced). Uses a manual cookie jar so behaviour does
# not depend on how .NET treats Secure cookies on http://localhost.

function New-RqSession([string]$BaseUrl) {
    [pscustomobject]@{ Base = $BaseUrl.TrimEnd('/'); Cookies = @{}; Csrf = $null }
}

function Invoke-RqApi {
    param($Session, [string]$Method, [string]$Path, $Body = $null, [switch]$AllowError, [string]$RawJson)
    $headers = @{ Origin = $Session.Base }
    if ($Session.Csrf) { $headers['X-Hexyrn-CSRF'] = $Session.Csrf }
    if ($Session.Cookies.Count) { $headers['Cookie'] = ($Session.Cookies.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join '; ' }
    $args2 = @{ Uri = "$($Session.Base)/api/v1$Path"; Method = $Method; Headers = $headers; UseBasicParsing = $true; ErrorAction = 'Stop' }
    if ($RawJson) { $args2.Body = $RawJson; $args2.ContentType = 'application/json' }
    elseif ($null -ne $Body) { $args2.Body = ($Body | ConvertTo-Json -Depth 8 -Compress); $args2.ContentType = 'application/json' }
    try { $resp = Invoke-WebRequest @args2 }
    catch {
        if (-not $AllowError) { throw }
        $r = $_.Exception.Response
        return [pscustomobject]@{ Status = [int]$r.StatusCode; Body = $null }
    }
    foreach ($sc in @($resp.Headers['Set-Cookie'])) {
        if ($sc -match '^([^=;]+)=([^;]*)') { if ($Matches[2]) { $Session.Cookies[$Matches[1]] = $Matches[2] } else { $Session.Cookies.Remove($Matches[1]) } }
    }
    $json = $null
    if ($resp.Content) { try { $json = $resp.Content | ConvertFrom-Json } catch { } }
    [pscustomobject]@{ Status = [int]$resp.StatusCode; Body = $json }
}

function ConvertFrom-Base32([string]$s) {
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    $bits = ''
    foreach ($c in $s.ToUpper().TrimEnd('=').ToCharArray()) { $bits += [Convert]::ToString($alphabet.IndexOf($c), 2).PadLeft(5, '0') }
    $bytes = New-Object byte[] ([math]::Floor($bits.Length / 8))
    for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($bits.Substring($i * 8, 8), 2) }
    , $bytes
}

# RFC 6238, SHA-1, 30 s, 6 digits (what authenticator apps and the server use).
function Get-Totp([string]$Base32Secret, [long]$UnixSeconds = ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())) {
    $key = ConvertFrom-Base32 $Base32Secret
    $counter = [long][math]::Floor($UnixSeconds / 30)
    $msg = [BitConverter]::GetBytes($counter); if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($msg) }
    $hmac = New-Object System.Security.Cryptography.HMACSHA1 -ArgumentList (, $key)
    $h = $hmac.ComputeHash($msg)
    $o = $h[$h.Length - 1] -band 0x0F
    $bin = ([int64]($h[$o] -band 0x7F) * 16777216) + ([int64]$h[$o + 1] * 65536) + ([int64]$h[$o + 2] * 256) + [int64]$h[$o + 3]
    ($bin % 1000000).ToString().PadLeft(6, '0')
}
