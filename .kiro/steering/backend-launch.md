# Backend launch convention (READ BEFORE STARTING THE BACKEND)

The SD Image Sorter backend is a long-lived daemon. Naive ways to launch it
from a shell tool (kiro-cli, Claude Code, Cursor, etc.) will hang the agent
**indefinitely**. There is one supported way to do it: `scripts/start-backend.ps1`.

## TL;DR for AI agents

When a user asks you to "start the backend", "run the server", "spin up the
API", or anything similar:

1. **Use `scripts/start-backend.ps1`. Never write `Start-Process` calls inline.**
2. **Split into two shell calls.** Spawn in call 1, probe in call 2.
3. **Do not pass `-HealthCheck`** when running from an AI shell tool. It is for
   humans running the script manually. AI agents do health checks in a
   separate shell call.

### The canonical pattern

Shell call 1 (spawn, returns within ~2s):

```powershell
& 'scripts/start-backend.ps1' -Port 8488 -Tag mywork
```

Shell call 2 (health-check, returns within ~1s):

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:8488/' -UseBasicParsing -TimeoutSec 5 |
  Select-Object StatusCode, @{N='Length';E={$_.Content.Length}}
```

If you need a fresh restart (port already in use):

```powershell
& 'scripts/start-backend.ps1' -Port 8488 -Tag mywork -Force
```

## What you must never do

These will hang the AI shell tool until the backend is killed by hand:

```powershell
# DO NOT: Start-Process with redirect flags
Start-Process -FilePath python.exe `
  -RedirectStandardOutput out.log `
  -RedirectStandardError err.log    # <-- this is the trap

# DO NOT: spawn daemon and probe in the same shell call
Start-Process ... ; Start-Sleep 5 ; Invoke-WebRequest ...

# DO NOT: run python main.py synchronously and expect it to background
python main.py    # blocks the shell forever
```

### Why these hang

`Start-Process -RedirectStandardOutput X -RedirectStandardError Y` forces .NET
to call `CreateProcess(bInheritHandles=TRUE)`. That flag inherits **every**
inheritable handle in the parent shell into the python child, including the
agent's own stdout/stderr pipes. The python daemon then holds those pipes open
for its entire lifetime, so the agent never sees EOF on its read and never
returns from the shell call.

`scripts/start-backend.ps1` works around this by writing a tiny launcher .bat
that does its own `>` `2>` `<NUL` redirect, then `Start-Process`-ing the .bat
without any `-RedirectStandard*` flags. python's stdout/stderr are wired
straight to log files; nothing leaks to the agent.

## Script reference

```
scripts/start-backend.ps1
  -Port <int>              default 8487 (or $env:SD_IMAGE_SORTER_PORT)
  -LogLevel <str>          default WARNING (or $env:SD_IMAGE_SORTER_LOG_LEVEL)
  -LogDir <path>           default <repo>/.tmp
  -Tag <str>               default 'backend'; baked into log file names
  -Force                   kill anything listening on -Port first
  -HealthCheck             after spawn, sleep + probe / (humans only)
  -WaitSeconds <int>       sleep before -HealthCheck probe; default 5
```

JSON written to stdout (single line, parse with `ConvertFrom-Json`):

```json
{
  "Pid":            42880,
  "Port":           8488,
  "StdoutLog":      "<repo>/.tmp/<Tag>-port<Port>-stdout.log",
  "StderrLog":      "<repo>/.tmp/<Tag>-port<Port>-stderr.log",
  "PidFile":        "<repo>/.tmp/<Tag>-port<Port>.pid",
  "LauncherBat":    "<repo>/.tmp/<Tag>-port<Port>-launcher.bat",
  "Started":        "2026-05-19T04:10:34.95+08:00",
  "AlreadyRunning": false,
  "HealthOK":       null
}
```

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Spawned, or already running (re-used existing daemon) |
| 2 | Port busy and `-Force` not given |
| 3 | `backend/venv/Scripts/python.exe` not found (run `run.bat` once) |
| 4 | Daemon spawned but `-HealthCheck` probe failed |

## Stopping a daemon

```powershell
$json = Get-Content '.tmp/<Tag>-port<Port>.pid' -Raw
Stop-Process -Id ([int]$json.Trim()) -Force
```

Or by port:

```powershell
$pids = @(Get-NetTCPConnection -LocalPort 8488 -State Listen -ErrorAction SilentlyContinue) |
  ForEach-Object { $_.OwningProcess } | Sort-Object -Unique
$pids | ForEach-Object { Stop-Process -Id $_ -Force }
```

## Choosing a port

- Default dev port (matches `run.bat`): `8487`
- For ad-hoc test runs, prefer ports `8500-8550` and use a unique `-Tag`
  per run (e.g. `-Tag v321-qa`) so log files don't collide
- Always check the port is free first:
  ```powershell
  @(Get-NetTCPConnection -LocalPort 8488 -State Listen -ErrorAction SilentlyContinue).Count
  ```

## When NOT to use this script

- The user is running the app interactively for their own use (they should
  use `run.bat` / `run-portable.bat`, not the AI's helper)
- Production / packaged release (the launcher batch handles all setup)
- Tests that need to capture stdout/stderr live (use a pytest fixture instead)
