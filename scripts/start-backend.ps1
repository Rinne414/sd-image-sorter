<#
.SYNOPSIS
    Launch the SD Image Sorter backend as a detached daemon, safe to call from
    AI shell tools (kiro-cli, etc.) without hanging.

.DESCRIPTION
    Spawns backend/main.py in the background using `cmd /c start /B` with file
    redirects. The launching shell does NOT inherit any pipes from the daemon,
    so kiro-cli's shell tool will see EOF immediately and return.

    Why not `Start-Process -RedirectStandardOutput`? Because that flag forces
    .NET to call CreateProcess(bInheritHandles=TRUE), which causes the python
    daemon to inherit ALL inheritable handles in the parent shell, including
    the AI agent's stdout/stderr pipes. The agent then waits for EOF on those
    pipes for as long as the daemon lives = forever. See repo doc:
    .kiro/steering/backend-launch.md

.PARAMETER Port
    HTTP port to bind. Default 8487.

.PARAMETER LogLevel
    SD_IMAGE_SORTER_LOG_LEVEL value. Default WARNING.

.PARAMETER LogDir
    Directory for stdout/stderr log files. Default <repo>/.tmp.

.PARAMETER Tag
    Short tag baked into the log file names so multiple ports / runs do not
    overwrite each other. Default "backend".

.PARAMETER Force
    If a process already listens on the chosen port, kill it before spawning.
    Default: do nothing and exit 2.

.PARAMETER HealthCheck
    After spawning, sleep $WaitSeconds and probe http://127.0.0.1:$Port/.
    Useful when running this script manually. AI agents should NOT pass this
    flag; do the probe in a separate shell call instead.

.PARAMETER WaitSeconds
    Seconds to sleep before -HealthCheck probe. Default 5.

.OUTPUTS
    A single object on stdout:
        Pid           : python.exe PID
        Port          : the chosen port
        StdoutLog     : path
        StderrLog     : path
        PidFile       : path
        Started       : ISO 8601 timestamp
        AlreadyRunning: $true if we found an existing healthy daemon

.EXAMPLE
    pwsh scripts/start-backend.ps1
    pwsh scripts/start-backend.ps1 -Port 8488 -Tag v321
    pwsh scripts/start-backend.ps1 -Port 8488 -Force -HealthCheck

.NOTES
    Exit codes:
        0  spawned (or already running)
        2  port busy and -Force not given
        3  python.exe not found
        4  daemon spawned but health check failed
#>

[CmdletBinding()]
param(
    [int]    $Port,
    [string] $LogLevel,
    [string] $LogDir,
    [string] $Tag         = 'backend',
    [switch] $Force,
    [switch] $HealthCheck,
    [int]    $WaitSeconds = 5
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# Apply env-var defaults (PS 5.1 compatible: no ternary in param block).
if (-not $PSBoundParameters.ContainsKey('Port')) {
    if ($env:SD_IMAGE_SORTER_PORT) { $Port = [int]$env:SD_IMAGE_SORTER_PORT } else { $Port = 8487 }
}
if (-not $PSBoundParameters.ContainsKey('LogLevel')) {
    if ($env:SD_IMAGE_SORTER_LOG_LEVEL) { $LogLevel = $env:SD_IMAGE_SORTER_LOG_LEVEL } else { $LogLevel = 'WARNING' }
}

# --- Resolve repo paths ----------------------------------------------------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Resolve-Path (Join-Path $scriptDir '..') | Select-Object -ExpandProperty Path
$backendDir = Join-Path $repoRoot 'backend'
$pyExe      = Join-Path $backendDir 'venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $pyExe)) {
    Write-Error "Python venv not found at: $pyExe`nRun run.bat once to create the venv."
    exit 3
}

if (-not $LogDir) { $LogDir = Join-Path $repoRoot '.tmp' }
if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$stdoutLog = Join-Path $LogDir "$Tag-port$Port-stdout.log"
$stderrLog = Join-Path $LogDir "$Tag-port$Port-stderr.log"
$pidFile   = Join-Path $LogDir "$Tag-port$Port.pid"

# --- Already running? ------------------------------------------------------
function Test-PortListening {
    param([int]$P)
    try {
        $conns = @(Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction Stop)
        return $conns
    } catch {
        return @()
    }
}

$existing = @(Test-PortListening -P $Port)
if ($existing.Count -gt 0) {
    $owners = @($existing | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)
    if ($Force) {
        Write-Verbose "Port $Port busy (PIDs: $($owners -join ',')) - killing because -Force."
        foreach ($opid in $owners) {
            try { Stop-Process -Id $opid -Force -ErrorAction Stop } catch {
                Write-Warning "Failed to stop PID $opid : $_"
            }
        }
        Start-Sleep -Milliseconds 500
    } else {
        # Treat as "already running" success - return the existing PID.
        $existingPid = $owners[0]
        $result = [PSCustomObject]@{
            Pid            = $existingPid
            Port           = $Port
            StdoutLog      = $stdoutLog
            StderrLog      = $stderrLog
            PidFile        = $pidFile
            Started        = $null
            AlreadyRunning = $true
        }
        $result | ConvertTo-Json -Compress | Write-Output
        exit 0
    }
}

# --- Build a tiny .bat launcher that detaches python ----------------------
# Why a .bat instead of `Start-Process cmd.exe -ArgumentList /c ...`?
#   1. Quoting through Start-Process -> cmd /c <quoted-command-with-quotes-inside>
#      is fragile (cmd's quote-stripping rules eat the wrong quotes).
#   2. Why not Start-Process -RedirectStandardOutput? That flag forces
#      Process.Start with bInheritHandles=TRUE, which causes the python child
#      to inherit ALL inheritable handles in the parent shell - including the
#      AI agent's stdout/stderr pipes. The agent then never sees EOF and hangs.
# A .bat does the redirect itself via cmd's `>` and `2>` operators, while
# Start-Process invokes the .bat without any -RedirectStandard* flags. Result:
# python's only handles point at log files; nothing leaks to the parent shell.
$pyExeQ     = '"' + $pyExe.Replace('"','""') + '"'
$stdoutLogQ = '"' + $stdoutLog.Replace('"','""') + '"'
$stderrLogQ = '"' + $stderrLog.Replace('"','""') + '"'
$launcherBat = Join-Path $LogDir "$Tag-port$Port-launcher.bat"
$batBody = @"
@echo off
$pyExeQ main.py 1>$stdoutLogQ 2>$stderrLogQ <NUL
"@
[System.IO.File]::WriteAllText($launcherBat, $batBody, [System.Text.Encoding]::ASCII)

# Pre-set env vars so the python child inherits them.
$env:SD_IMAGE_SORTER_PORT      = "$Port"
$env:SD_IMAGE_SORTER_LOG_LEVEL = "$LogLevel"

# Spawn the .bat. -WindowStyle Hidden + no -RedirectStandard* avoids handle
# inheritance. The bat blocks until python exits, so we DON'T -Wait on it.
$cmdProc = Start-Process `
    -FilePath $launcherBat `
    -WorkingDirectory $backendDir `
    -WindowStyle Hidden `
    -PassThru

# Give the bat a beat to spawn python and start binding the port.
Start-Sleep -Milliseconds 500

# --- Find the python child (cmd is gone by now) ----------------------------
# We can't easily get the child PID of an exited cmd, so we identify the
# python.exe that is now bound to our chosen port. Poll briefly.
$daemonPid = $null
$deadline  = (Get-Date).AddSeconds(8)
while ((Get-Date) -lt $deadline) {
    $owners = @((Test-PortListening -P $Port) | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)
    if ($owners.Count -gt 0) {
        $daemonPid = $owners[0]
        break
    }
    Start-Sleep -Milliseconds 250
}

if (-not $daemonPid) {
    # Fall back to any python.exe we just spawned under this venv. Best effort.
    $candidates = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
                  Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $pyExe) })
    if ($candidates.Count -gt 0) {
        $daemonPid = ($candidates | Sort-Object CreationDate -Descending | Select-Object -First 1).ProcessId
    }
}

if ($daemonPid) {
    Set-Content -LiteralPath $pidFile -Value "$daemonPid" -Encoding ASCII
}

# --- Optional health check -------------------------------------------------
$healthOK = $null
if ($HealthCheck) {
    Start-Sleep -Seconds $WaitSeconds
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5
        $healthOK = ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500)
    } catch {
        $healthOK = $false
    }
}

# --- Output result ---------------------------------------------------------
$result = [PSCustomObject]@{
    Pid            = $daemonPid
    Port           = $Port
    StdoutLog      = $stdoutLog
    StderrLog      = $stderrLog
    PidFile        = $pidFile
    LauncherBat    = $launcherBat
    Started        = (Get-Date).ToString('o')
    AlreadyRunning = $false
    HealthOK       = $healthOK
}
$result | ConvertTo-Json -Compress | Write-Output

if ($HealthCheck -and -not $healthOK) { exit 4 }
exit 0
