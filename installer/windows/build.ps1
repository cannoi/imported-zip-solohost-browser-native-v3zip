#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$proj = Join-Path $root "native\windows\SoloHostBrowser\SoloHostBrowser.csproj"
$out  = Join-Path $root "dist\windows"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  Write-Host "dotnet SDK is required to BUILD. End users do not need it."
  Write-Host "Install from https://dot.net then run this script on Windows."
  exit 2
}

New-Item -ItemType Directory -Force -Path $out | Out-Null
dotnet publish $proj -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -o $out

Write-Host "Published: $out\SoloHostBrowser.exe"
Write-Host "NATIVE BUILD complete on this machine only if the command succeeded."
