param(
  [Parameter(Mandatory = $true)]
  [string]$Version
)

# Release script: bump version -> build -> pack release zip
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  Write-Error "Version must be semver, e.g. 0.1.1"
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

Write-Host "==> Packing release zip ..."
$releaseDir = Join-Path $root 'release'
New-Item -ItemType Directory -Force $releaseDir | Out-Null
$zipPath = Join-Path $releaseDir "dsh-ob-$Version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $root 'main.js'), (Join-Path $root 'manifest.json'), (Join-Path $root 'styles.css') -DestinationPath $zipPath

Write-Host "==> Publishing GitHub release (zip + standalone files, for BRAT) ..."
gh release create $Version $zipPath --title $Version --notes "DSH for Obsidian $Version" 2>$null
gh release upload $Version (Join-Path $root 'main.js'), (Join-Path $root 'manifest.json'), (Join-Path $root 'styles.css') --clobber 2>$null

Write-Host ""
Write-Host "Done! Next steps:"
Write-Host "  1. git add -A ; git commit -m 'v$Version' ; git push"
