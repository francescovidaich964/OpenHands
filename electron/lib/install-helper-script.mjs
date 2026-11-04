/**
 * PowerShell helper that installs an archived build after the app has quit.
 *
 * Installing replaces the running app (and stops its backend), so it cannot be
 * done from inside the app: self-update.mjs writes this script to %TEMP%,
 * starts it through HELPER_LAUNCHER_PS1 (below), and quits. The helper then
 *   1. waits for the app PID to exit, then for every process running from the
 *      install directory to disappear (files in use would break the install),
 *   2. runs the installer silently (/S) and records its exit code,
 *   3. logs to %LOCALAPPDATA%\AgentCanvasBuilds\install.log,
 *   4. relaunches the app — unless an instance is already running (NSIS may
 *      start it itself) — whether or not the install succeeded, so the user
 *      is never left without a running app,
 *   5. deletes its own script file.
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
$installerHung = $false

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
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-InstallDirProcesses) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
  }
  $left = @(Get-InstallDirProcesses)
  if ($left.Count -gt 0) {
    Write-Log ("ABORT: still running from install dir after 60 s: " + (($left | ForEach-Object { '{0}({1})' -f $_.ProcessName, $_.Id }) -join ', '))
    $proceed = $false
  }
}

# 2. silent install
if ($proceed) {
  if (-not (Test-Path -LiteralPath $Installer)) {
    Write-Log "ABORT: installer not found: $Installer"
  } else {
    try {
      $proc = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru
      $null = $proc.Handle  # keep a handle so ExitCode is available after exit
      Write-Log "installer started (pid $($proc.Id))"
      # Bounded wait: a dialog nobody can see (hidden helper) must not park us forever.
      if ($proc.WaitForExit(600000)) {
        Write-Log "installer exit code: $($proc.ExitCode)"
      } else {
        Write-Log "installer still running after 10 min (pid $($proc.Id)); not waiting any longer"
        $installerHung = $true
      }
    } catch {
      Write-Log "installer failed to start: $($_.Exception.Message)"
    }
  }
}

# 4. relaunch (skip if an instance is already up)
Start-Sleep -Seconds 2
$running = Get-InstallDirProcesses | Where-Object { $_.ProcessName -ieq [IO.Path]::GetFileNameWithoutExtension($AppExe) }
if ($running) {
  Write-Log ("app already running from the install dir (pid " + (($running | ForEach-Object { $_.Id }) -join ', ') + "); not relaunching")
} elseif ($installerHung) {
  # Starting the app against a directory the installer is still rewriting would make things worse.
  Write-Log "relaunch skipped: the installer is still running; start the app by hand once it is gone"
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
try { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction Stop } catch {}
`;

/**
 * Starts the helper. Run by self-update.mjs as a short-lived, NON-detached
 * child; it prints the helper's PID. The helper is a grandchild of the app on
 * purpose: libuv puts non-detached children in a kill-on-close job object (they
 * would die with the app), but lets their own children break away silently;
 * and `spawn({detached: true})` of powershell.exe was measured to exit 0
 * without running anything. Arguments come in through environment variables
 * (AC_HELPER_*) so no path is ever pasted into code. A helper that dies at
 * once (e.g. parameter binding) is reported as a failure so the app stays open.
 */
export const HELPER_LAUNCHER_PS1 = String.raw`$ErrorActionPreference = 'Stop'
# Double a trailing backslash so it cannot escape the closing quote.
$q = { param($s) '"' + ($s -replace '\\$', '\\') + '"' }
$a = @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
  '-File', (& $q $env:AC_HELPER_SCRIPT),
  '-AppPid', $env:AC_HELPER_APP_PID,
  '-Installer', (& $q $env:AC_HELPER_INSTALLER),
  '-AppExe', (& $q $env:AC_HELPER_APP_EXE),
  '-InstallDir', (& $q $env:AC_HELPER_INSTALL_DIR),
  '-LogFile', (& $q $env:AC_HELPER_LOG_FILE)
)
$p = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru -ArgumentList $a
$null = $p.Handle
if ($p.WaitForExit(3000)) {
  [Console]::Error.WriteLine("install helper exited immediately (code $($p.ExitCode))")
  exit 1
}
Write-Output $p.Id
`;
