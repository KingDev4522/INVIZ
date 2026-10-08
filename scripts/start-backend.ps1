# INVIZ backend starter (Windows): rebuild, restart detached, health-check.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\start-backend.ps1
# Run from the repo root (INVIZ/). The backend keeps running after the
# terminal closes. If it ever dies (reboot, crash), just run this again.
#
# ASCII ONLY in this file: PowerShell 5.1 mis-decodes non-ASCII in a BOM-less
# .ps1 (mojibake in messages, and parse errors on some hosts).
$ErrorActionPreference = "Stop"
$BackendDir = Join-Path $PSScriptRoot "..\backend"
$ServerJs = "dist/backend/src/server.js"
$Port = 8787
$HealthUrl = "http://127.0.0.1:$Port/v1/health"

function Get-BackendProcesses {
  # Matches the backend by its server entrypoint, so an unrelated node process
  # is never touched.
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*$ServerJs*" })
}

function Test-BackendHealthy {
  try {
    $h = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 3 -UseBasicParsing
    return ($h.StatusCode -eq 200)
  } catch { return $false }
}

Write-Output "[1/4] Building backend..."
& npm run build --prefix $BackendDir | Select-Object -Last 3

Write-Output "[2/4] Checking for an existing backend..."
# NOTE the @() here, not just inside the function: PowerShell unrolls a
# single-element array on output, so a bare CimInstance came back and its
# .Count was empty (not 1) - which silently broke the enumeration below.
$existing = @(Get-BackendProcesses)
# This script is "start/restart": it always restarts, so a freshly built
# dist/ is what actually runs (skipping the restart when a healthy backend was
# already up left stale code serving). Restarting is ALSO how duplicates are
# prevented - every existing instance is stopped and exactly one new one is
# started, so the port is never contended.
if ($existing.Count -gt 0) {
  $healthy = Test-BackendHealthy
  Write-Output "  Stopping $($existing.Count) existing backend process(es) (was healthy: $healthy)..."
  foreach ($e in $existing) { Stop-Process -Id $e.ProcessId -Force -ErrorAction SilentlyContinue }
}
# Wait for the port to be genuinely released before rebinding.
for ($i = 0; $i -lt 20; $i++) {
  $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $busy) { break }
  Start-Sleep -Milliseconds 500
}

Write-Output "[3/4] Starting backend (detached, logs to backend/server-8787.*.log)..."
# NOTE: redirect paths MUST be absolute. .NET resolves relative redirect paths
# against the caller's working directory, not -WorkingDirectory - relative
# names once scattered logs into the repo root instead of backend/.
# Resolve node explicitly: a detached child can resolve a bare "node" against a
# different PATH than this session, which failed the launch with no error here.
$nodeExe = (Get-Command node -ErrorAction Stop).Source
# -WindowStyle Hidden is the load-bearing part: without it the child INHERITS
# this console, so closing the terminal that ran this script delivered
# CTRL_CLOSE_EVENT to the backend and it died. Hidden gives the backend its own
# console, so it survives the launcher's exit (and the closing of any console
# or IDE terminal that started it).
$proc = Start-Process -FilePath $nodeExe `
  -ArgumentList $ServerJs `
  -WorkingDirectory $BackendDir `
  -RedirectStandardOutput (Join-Path $BackendDir "server-8787.out.log") `
  -RedirectStandardError (Join-Path $BackendDir "server-8787.err.log") `
  -WindowStyle Hidden `
  -PassThru
Write-Output "PID=$($proc.Id)"

Write-Output "[4/4] Health check (waiting up to 30s)..."
$ok = $false
$h = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  # Stop waiting the moment the process dies instead of burning the full budget.
  if ($proc.HasExited) {
    Write-Output "Backend process exited with code $($proc.ExitCode) during startup."
    break
  }
  try {
    $h = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 3 -UseBasicParsing
    if ($h.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}
if (-not $ok) {
  Write-Output "HEALTH CHECK FAILED -- tail of error log:"
  Get-Content -LiteralPath (Join-Path $BackendDir "server-8787.err.log") -Tail 15 -ErrorAction SilentlyContinue
  exit 1
}
# Liveness: the PID that owns the port must be the one we launched. This is what
# actually proves the backend is detached rather than merely up for an instant.
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$owner = if ($listener) { ($listener | Select-Object -First 1).OwningProcess } else { 0 }
Write-Output "HEALTH OK: $($h.Content)"
Write-Output "Listener PID=$owner (launched PID=$($proc.Id); alive=$(-not $proc.HasExited))"
if ($owner -ne $proc.Id -or $proc.HasExited) {
  Write-Output "WARNING: the listening process is not the one this script launched."
  Write-Output "Run this script again; it will not start a duplicate while a healthy backend is up."
}
Write-Output "Validate from the extension Options page: Validate backend (live)."