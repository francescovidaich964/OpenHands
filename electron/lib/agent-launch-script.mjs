/**
 * Starts a conflict-resolution agent (opencode / Claude Code) so that it keeps
 * running after the app quits or the rebase moves on.
 *
 * Two scripts, same shape as the install helper (see install-helper-script.mjs):
 *
 *  1. AGENT_LAUNCHER_PS1 is short-lived and NON-detached (upstream-sync.mjs runs
 *     it with `spawn` and reads the PID from its stdout). libuv puts non-detached
 *     children in a kill-on-close job object, but lets their grandchildren break
 *     away, and `spawn({ detached: true })` of powershell.exe was measured to run
 *     nothing on this machine. The launcher only `Start-Process`es the wrapper and
 *     prints its PID.
 *  2. AGENT_WRAPPER_PS1 is the long-lived process whose PID the app records: it
 *     runs the agent with the call operator, which waits, so this PID is alive
 *     exactly as long as the agent is. `Start-Process -FilePath <agent>` was the
 *     first attempt and is wrong twice over — it cannot resolve an npm `.cmd` shim
 *     by name, and its argument quoting split the prompt into several arguments
 *     (measured; see the fix-round-1 report).
 *
 * Nothing is pasted into script text: the paths come from the launcher's
 * environment and are handed to the wrapper as quoted `-File` parameters; the
 * agent's argv lives in a file with one argument per line, read as UTF-8 (Windows
 * PowerShell would otherwise decode it with the ANSI codepage and mangle a
 * non-ASCII task path). The two logs are written as UTF-8 without a BOM because
 * that is what the app reads them back as — `2>` and `>` in Windows PowerShell
 * would have produced UTF-16 files. An agent that dies at once is reported as a
 * failure (a CLI that is not really installed usually exits immediately).
 */
export const AGENT_LAUNCHER_PS1 = String.raw`$ErrorActionPreference = 'Stop'
# Double a trailing backslash so it cannot escape the closing quote.
$q = { param($s) '"' + ($s -replace '\\$', '\\') + '"' }
$a = @(
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
  '-File', (& $q $env:AC_AGENT_WRAPPER),
  '-Exe', (& $q $env:AC_AGENT_EXE),
  '-ArgsFile', (& $q $env:AC_AGENT_ARGS_FILE),
  '-WorkDir', (& $q $env:AC_AGENT_CWD),
  '-LogFile', (& $q $env:AC_AGENT_LOG),
  '-ErrLogFile', (& $q $env:AC_AGENT_ERR_LOG)
)
$p = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru -ArgumentList $a
$null = $p.Handle
if ($p.WaitForExit(3000)) {
  [Console]::Error.WriteLine("agent wrapper exited immediately (code $($p.ExitCode))")
  exit 1
}
Write-Output $p.Id
`;

/**
 * Written verbatim to `<archiveDir>/sync-agent-<stamp>.wrapper.ps1` next to the
 * task and args files, and started by the launcher. ASCII only, so Windows
 * PowerShell reads it the same way with or without a BOM.
 */
export const AGENT_WRAPPER_PS1 = String.raw`param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$ArgsFile,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $true)][string]$LogFile,
  [Parameter(Mandatory = $true)][string]$ErrLogFile
)
$ErrorActionPreference = 'Stop'
$out = New-Object System.IO.StreamWriter($LogFile, $false, (New-Object System.Text.UTF8Encoding($false)))
$err = New-Object System.IO.StreamWriter($ErrLogFile, $false, (New-Object System.Text.UTF8Encoding($false)))
# The panel shows this log while the agent works, so every line goes out at once.
$out.AutoFlush = $true
$err.AutoFlush = $true
try {
  # One argument per line. UTF-8 is explicit: the app wrote the file as UTF-8 and
  # Windows PowerShell would otherwise read it in the ANSI codepage.
  $argList = @(Get-Content -LiteralPath $ArgsFile -Encoding UTF8 | Where-Object { $_.Length -gt 0 })
  if ($argList.Count -eq 0) { throw "no arguments in $ArgsFile" }
  Set-Location -LiteralPath $WorkDir
  # & resolves an npm .cmd shim through PATH/PATHEXT and quotes each array element,
  # so the prompt stays one argument. Continue: a native command writing to stderr
  # must not end this script, or the PID the app watches would die with it.
  $ErrorActionPreference = 'Continue'
  # opencode and claude are Node programs that write UTF-8. Windows PowerShell
  # decodes a native command's output in the console's OEM codepage, which turns
  # every non-ASCII path in the log the panel shows into mojibake.
  try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  } catch {
    # No console to reconfigure: the log just keeps the console's own encoding.
  }
  & $Exe @argList 2>&1 | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) {
      $err.WriteLine($_.ToString())
    } else {
      $out.WriteLine($_.ToString())
    }
  }
} catch {
  $err.WriteLine("agent wrapper failed: $($_.Exception.Message)")
  $out.WriteLine('exit=1')
  $out.Dispose()
  $err.Dispose()
  exit 1
}
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
$out.WriteLine("exit=$code")
$out.Dispose()
$err.Dispose()
exit $code
`;
