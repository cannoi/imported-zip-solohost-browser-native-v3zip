#Requires -Version 5.1
$target = Join-Path $env:LOCALAPPDATA "Programs\SoloHostBrowser"
$lnk = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\SoloHost Browser.lnk"
if (Test-Path $lnk) { Remove-Item $lnk -Force }
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
Write-Host "Removed application files. Profile kept at %LOCALAPPDATA%\SoloHost\Browser"
Write-Host "Delete that folder to also remove history and bookmarks."
