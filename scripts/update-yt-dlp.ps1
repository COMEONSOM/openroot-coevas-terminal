$ErrorActionPreference = "Stop"

# Keep this pinned to an official stable release and its SHA-256 from the
# yt-dlp GitHub release page. Never use yt-dlp's in-place self-updater here.
$version = "2026.10.21"
$expectedSha256 = "33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555"
$downloadUrl = "https://github.com/yt-dlp/yt-dlp/releases/download/$version/yt-dlp.exe"
$destination = Join-Path $PSScriptRoot "..\server\yt-dlp.exe"
$temporary = Join-Path $env:TEMP "yt-dlp-$version-$([guid]::NewGuid().ToString('N')).exe"

try {
  Invoke-WebRequest -Uri $downloadUrl -OutFile $temporary
  $actualSha256 = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) {
    throw "SHA-256 verification failed for yt-dlp $version"
  }

  $actualVersion = (& $temporary --version).Trim()
  if ($actualVersion -ne $version) {
    throw "Downloaded executable reports version '$actualVersion', expected '$version'"
  }

  Move-Item -LiteralPath $temporary -Destination $destination -Force
  Write-Output "Installed verified yt-dlp $actualVersion at $destination"
}
finally {
  if (Test-Path -LiteralPath $temporary) {
    Remove-Item -LiteralPath $temporary -Force
  }
}
