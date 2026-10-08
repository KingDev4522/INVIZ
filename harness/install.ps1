# Installs the INVIZ harness native host (Windows + Chrome).
# Usage (from the repo root INVIZ/):
#   powershell -ExecutionPolicy Bypass -File harness\install.ps1 -ExtensionId <id from chrome://extensions>
# What it does:
#   1. checks python + `import browser_harness` (pip install browser-harness first)
#   2. writes harness\inviz-harness.bat (python launcher) + com.inviz.harness.json
#   3. registers HKCU:\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.inviz.harness
# ASCII only in this file: PS 5.1 mis-decodes non-ASCII in BOM-less scripts.
param(
  [Parameter(Mandatory = $true)][string]$ExtensionId,
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$HarnessDir = $PSScriptRoot

Write-Output "[1/4] Checking python + browser_harness..."
& $Python -c "import browser_harness, sys; print('browser_harness ok on', sys.version.split()[0])"
if ($LASTEXITCODE -ne 0) {
  Write-Output "MISSING: run `python -m pip install browser-harness` first."
  exit 1
}
$PythonExe = (& $Python -c "import sys; print(sys.executable)").Trim()
Write-Output "python: $PythonExe"

Write-Output "[2/4] Writing launcher + host manifest..."
$BatPath = Join-Path $HarnessDir "inviz-harness.bat"
Set-Content -LiteralPath $BatPath -Encoding Ascii -Value "@echo off`r`n`"$PythonExe`" `"%~dp0inviz_host.py`""
$Manifest = @{
  name = "com.inviz.harness"
  description = "INVIZ harness host (browser-use/browser-harness execution)"
  path = $BatPath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
$ManifestPath = Join-Path $HarnessDir "com.inviz.harness.json"
Set-Content -LiteralPath $ManifestPath -Encoding Ascii -Value $Manifest

Write-Output "[3/4] Registering native host (HKCU, Chrome)..."
$RegKey = "HKCU:\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.inviz.harness"
if (-not (Test-Path -LiteralPath $RegKey)) {
  New-Item -Path $RegKey -Force | Out-Null
}
Set-ItemProperty -LiteralPath $RegKey -Name "(default)" -Value $ManifestPath

Write-Output "[4/4] Verifying..."
$Registered = (Get-ItemProperty -LiteralPath $RegKey -Name "(default)")."(default)"
Write-Output "registered manifest: $Registered"
Write-Output "DONE. Next:"
Write-Output "  1. Enable remote debugging for your Chrome (first harness run opens chrome://inspect for the one-click approval)."
Write-Output "  2. Reload the INVIZ extension, open its popup, enable 'Harness exec' (+ 'Power mode' if you want zero confirmations)."
Write-Output "  3. Test: python harness/host_selftest.py  (no browser needed)"
