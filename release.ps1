param(
  [Parameter(Mandatory = $true)]
  [string]$Version
)

# Release script: bump version -> build -> commit -> push tag (CI creates release + attestation)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  Write-Error "Version must be semver, e.g. 0.1.3"
}

Write-Host "==> Updating manifest.json / versions.json to $Version ..."

# .NET read/write (UTF-8 without BOM), avoiding PS 5.1 encoding pitfalls
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

$manifestPath = Join-Path $root 'manifest.json'
$manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
$minApp = $manifest.minAppVersion
$manifest.version = $Version
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10), $Utf8NoBom)

$versionsPath = Join-Path $root 'versions.json'
$versions = [System.IO.File]::ReadAllText($versionsPath) | ConvertFrom-Json
$versions | Add-Member -NotePropertyName $Version -NotePropertyValue $minApp -Force
[System.IO.File]::WriteAllText($versionsPath, ($versions | ConvertTo-Json -Depth 10), $Utf8NoBom)

Write-Host "==> Building ..."
npm run build | Out-Null

Write-Host "==> Committing and pushing ..."
git add -A
git commit -m "v$Version"
git push origin main

Write-Host "==> Pushing tag to trigger CI release + attestation ..."
git tag $Version
git push origin $Version

Write-Host ""
Write-Host "Done! CI will build, attest, and create the release."
Write-Host "  https://github.com/moozhu/dsh-obsidian/actions"
