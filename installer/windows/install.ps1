#Requires -Version 5.1
# Per-user install. No administrator required. Does not install Docker or SoloHost.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path (Split-Path -Parent (Split-Path -Parent $here)) "dist\windows"
$target = Join-Path $env:LOCALAPPDATA "Programs\SoloHostBrowser"

if (-not (Test-Path (Join-Path $dist "SoloHostBrowser.exe"))) {
  Write-Host "Build first: installer\\windows\\build.ps1"
  exit 2
}

New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Recurse -Force (Join-Path $dist "*") $target

$wscript = New-Object -ComObject WScript.Shell
$programs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
New-Item -ItemType Directory -Force -Path $programs | Out-Null
$lnk = $wscript.CreateShortcut((Join-Path $programs "SoloHost Browser.lnk"))
$lnk.TargetPath = Join-Path $target "SoloHostBrowser.exe"
$lnk.WorkingDirectory = $target
$lnk.Save()

Write-Host "Installed for this user: $target"
Write-Host "If WebView2 Runtime is missing, the app will offer the official installer."
