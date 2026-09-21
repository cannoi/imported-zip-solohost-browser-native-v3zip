# Structural smoke test. Does not launch WebView2 (requires Windows).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$proj = Join-Path $root "native\windows\SoloHostBrowser"

$required = @(
  "SoloHostBrowser.csproj",
  "Program.cs",
  "MainForm.cs",
  "Runtime\WebView2Detector.cs",
  "Profile\Paths.cs",
  "SoloHost\SoloHostClient.cs",
  "Resources\start.html",
  "Resources\diagnostics.html"
)
foreach ($f in $required) {
  $p = Join-Path $proj $f
  if (-not (Test-Path $p)) { throw "missing $f" }
}
Write-Host "PASS structural files"
Write-Host "NATIVE WINDOWS BUILD NOT EXECUTED"
