/**
 * PowerShell helper that installs an archived build after the app has quit.
 *
 * Installing replaces the running app (and stops its backend), so it cannot be
 * done from inside the app: self-update.mjs writes this script to %TEMP%,
 * spawns it detached, and quits. The helper then
 *   1. waits for the app PID to exit, then for every process running from the
 *      install directory to disappear (files in use would break the install),
 *   2. runs the installer silently (/S) and records its exit code,
 *   3. logs to %LOCALAPPDATA%\AgentCanvasBuilds\install.log,
 *   4. relaunches the app — unless an instance is already running (NSIS may
 *      start it itself) — whether or not the install succeeded, so the user
 *      is never left without a running app.
 */
export const INSTALL_HELPER_PS1 = String.raw`param(
  [Parameter(Mandatory = $true)][int]$AppPid,
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$AppExe,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$LogFile
)
$ErrorActionPreference = 'Continue'

function Write-Log([string]$msg) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8 } catch {}
}

function Get-InstallDirProcesses {
  $prefix = ($InstallDir.TrimEnd('\') + '\')
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $p = $null
    try { $p = $_.Path } catch {}
    $p -and $p.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  }
}

Write-Log "helper started: installer=$Installer appPid=$AppPid installDir=$InstallDir"
$proceed = $true

# 1. wait for the app, then for anything still running from the install dir
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Process -Id $AppPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
}
if (Get-Process -Id $AppPid -ErrorAction SilentlyContinue) {
  Write-Log "ABORT: app (pid $AppPid) still running after 60 s"
  $proceed = $false
}
if ($proceed) {
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-InstallDirProcesses) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
  }
  $left = @(Get-InstallDirProcesses)
  if ($left.Count -gt 0) {
    Write-Log ("ABORT: still running from install dir after 30 s: " + (($left | ForEach-Object { '{0}({1})' -f $_.ProcessName, $_.Id }) -join ', '))
    $proceed = $false
  }
}

# 2. silent install
if ($proceed) {
  if (-not (Test-Path -LiteralPath $Installer)) {
    Write-Log "ABORT: installer not found: $Installer"
  } else {
    try {
      $proc = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
      Write-Log "installer exit code: $($proc.ExitCode)"
    } catch {
      Write-Log "installer failed to start: $($_.Exception.Message)"
    }
  }
}

# 4. relaunch (skip if an instance is already up)
Start-Sleep -Seconds 2
$running = Get-InstallDirProcesses | Where-Object { $_.ProcessName -ieq [IO.Path]::GetFileNameWithoutExtension($AppExe) }
if ($running) {
  Write-Log 'app already running (started by the installer); not relaunching'
} elseif (Test-Path -LiteralPath $AppExe) {
  try {
    Start-Process -FilePath $AppExe
    Write-Log "relaunched $AppExe"
  } catch {
    Write-Log "relaunch failed: $($_.Exception.Message)"
  }
} else {
  Write-Log "relaunch skipped: $AppExe not found"
}
Write-Log 'helper done'
`;
