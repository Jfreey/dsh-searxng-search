# Idempotent SearXNG installer for Windows, sized for the dsh-searxng-search plugin.
#
# Creates: a shallow clone of SearXNG, a virtualenv with its requirements, a
# settings file that serves the JSON API, a launcher wrapper, and a per-user
# scheduled task that starts the server at logon. Re-running repairs or upgrades
# in place and never overwrites an existing settings file.
#
#   powershell -ExecutionPolicy Bypass -File .\bootstrap-searxng.ps1
#   powershell -ExecutionPolicy Bypass -File .\bootstrap-searxng.ps1 -Print
#   ... -Bind 0.0.0.0      # when another host must reach it
#
# REQUIRES WSL. SearXNG does not run natively on Windows: searx/valkeydb.py
# imports the POSIX-only `pwd` module and the app dies at import time, before it
# ever binds a port. This script therefore refuses to build an install outside
# WSL and leaves nothing behind; inside a WSL distribution it is the same install
# as bootstrap-searxng.sh, only driven from PowerShell.
#
# Requires inside WSL: git, and Python 3.11+ (the py launcher is preferred).
# Linux and macOS use bootstrap-searxng.sh in this directory.

[CmdletBinding()]
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\searxng",
  [int]$Port = 8888,
  [string]$TaskName = "SearXNG",
  [string]$Python = "",
  [string]$Engines = "bing,sogou,360search",
  [string]$Bind = "127.0.0.1",
  [string]$Repo = "https://github.com/searxng/searxng.git",
  # Tried when the direct clone fails (GitHub is TLS-blocked on some CN networks).
  [string]$MirrorRepo = "https://gh-proxy.com/https://github.com/searxng/searxng.git",
  # Last resort, and the only path that works on Windows at all: the repo ships a
  # path NTFS cannot create, so a checkout fails there regardless of network.
  [string]$TarUrl = "https://gh-proxy.com/https://codeload.github.com/searxng/searxng/tar.gz/refs/heads/master",
  [switch]$Print
)

$ErrorActionPreference = "Stop"

# SearXNG imports `pwd` from searx/valkeydb.py, so a native Windows install can
# never start. Refuse early instead of leaving a broken tree and a dead task.
if (-not $env:WSL_DISTRO_NAME) {
  throw @"
SearXNG cannot run natively on Windows: searx/valkeydb.py imports the POSIX-only
'pwd' module and the server fails at import. Nothing was installed.

Pick one:
  1. WSL (recommended): install a distribution (wsl --install -d Ubuntu), then run
     scripts/bootstrap-searxng.sh inside it, or this script from inside WSL.
  2. Docker Desktop: run the upstream SearXNG image.
  3. Keep SearXNG on a Linux or macOS host and point the DSH plugin at it with
     config.baseUrl, e.g. http://192.168.1.50:8888.
"@
}

function Write-Step([string]$Message) {
  Write-Host "  - $Message"
}

function Invoke-Step([scriptblock]$Action, [string]$Description) {
  if ($Print) {
    Write-Host "    would: $Description"
    return
  }
  # A native command writing to stderr (git's clone progress, pip's warnings)
  # becomes a terminating error under ErrorActionPreference=Stop, so native
  # failures must be judged by exit code instead of by the error stream.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Action
  } finally {
    $ErrorActionPreference = $previous
  }
  # Without this, a failed clone or pip leaves a half-built install that only
  # fails later as "No module named searx".
  if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE." }
}

$Settings = Join-Path $InstallDir "searxng.yml"
$Venv = Join-Path $InstallDir ".venv"
$Launcher = Join-Path $InstallDir "searxng-server.cmd"
$Health = "http://127.0.0.1:$Port/healthz"

# --- prerequisites ---------------------------------------------------------

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "git is required on PATH."
}

function Resolve-Python {
  $candidates = @()
  if ($Python) { $candidates += @{ Exe = $Python; Args = @() } }
  # A uv-managed interpreter is the common case on a machine without a system
  # Python: uv installs into %APPDATA%\uv\python and never touches PATH.
  $uvRoot = Join-Path $env:APPDATA "uv\python"
  if (Test-Path $uvRoot) {
    foreach ($dir in (Get-ChildItem $uvRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) {
      $exe = Join-Path $dir.FullName "python.exe"
      if (Test-Path $exe) { $candidates += @{ Exe = $exe; Args = @() } }
    }
  }
  $candidates += @{ Exe = "py"; Args = @("-3.11") }
  $candidates += @{ Exe = "py"; Args = @("-3.12") }
  $candidates += @{ Exe = "py"; Args = @("-3.13") }
  $candidates += @{ Exe = "python"; Args = @() }
  foreach ($candidate in $candidates) {
    if ([System.IO.Path]::IsPathRooted($candidate.Exe)) {
      if (-not (Test-Path $candidate.Exe)) { continue }
    } elseif (-not (Get-Command $candidate.Exe -ErrorAction SilentlyContinue)) {
      continue
    }
    & $candidate.Exe @($candidate.Args) -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" 2>$null
    if ($LASTEXITCODE -eq 0) { return $candidate }
  }
  throw "Python 3.11+ not found. Install it or pass -Python <path-to-python.exe>."
}

# --- 1. source tree --------------------------------------------------------

$SrcCheck = Join-Path $InstallDir "searx\webapp.py"

function Test-Ours([string]$Path) {
  return (Test-Path (Join-Path $Path ".git")) -or
         (Test-Path (Join-Path $Path ".venv")) -or
         (Test-Path (Join-Path $Path "searxng.yml"))
}

if (Test-Path $SrcCheck) {
  Write-Step "source present: $InstallDir"
} else {
  if (Test-Path $InstallDir) {
    if (Test-Ours $InstallDir) {
      Write-Step "clearing an incomplete install at $InstallDir"
      Invoke-Step { Remove-Item -Recurse -Force $InstallDir } "clear $InstallDir"
    } else {
      throw "$InstallDir exists and holds unrelated files; move it away first."
    }
  }

  $cloned = $false
  foreach ($repo in @($Repo, $MirrorRepo)) {
    if ([string]::IsNullOrWhiteSpace($repo)) { continue }
    Write-Step "cloning $repo"
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    try {
      Invoke-Step { & git clone --depth 1 $repo $InstallDir } "git clone --depth 1 $repo"
      $cloned = Test-Path $SrcCheck
    } catch {
      Write-Step "clone did not produce a usable tree: $($_.Exception.Message)"
    }
    if ($cloned) { break }
  }

  if (-not $cloned) {
    # SearXNG ships utils/templates/etc/httpd/sites-available/searxng.conf:socket,
    # a name NTFS cannot create, so a Windows checkout always fails there. The
    # tarball path skips that subtree and still yields a runnable package.
    Write-Step "extracting a source tarball instead (Windows cannot check out a ':' path)"
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $tarball = Join-Path $env:TEMP "searxng-src.tar.gz"
    Invoke-Step { & curl.exe -sL -o $tarball $TarUrl } "download $TarUrl"
    Invoke-Step { & tar.exe -xzf $tarball -C $InstallDir --strip-components=1 --exclude "*/utils/*" } "extract the tarball"
    if (-not (Test-Path $SrcCheck)) {
      throw "Neither git nor the tarball produced $SrcCheck. Retry with -Repo / -TarUrl pointing at a reachable mirror."
    }
  }
}

# --- 2. virtualenv and requirements ---------------------------------------

if (Test-Path (Join-Path $Venv "Scripts\python.exe")) {
  Write-Step "virtualenv present"
} else {
  $resolved = Resolve-Python
  Write-Step "creating virtualenv with $($resolved.Exe) $($resolved.Args -join ' ')"
  Invoke-Step { & $resolved.Exe @($resolved.Args) -m venv $Venv } "create venv at $Venv"
}

$VenvPython = Join-Path $Venv "Scripts\python.exe"
Write-Step "installing requirements (first run takes a few minutes)"
Invoke-Step { & $VenvPython -m pip install --quiet --upgrade pip } "upgrade pip"
Invoke-Step { & $VenvPython -m pip install --quiet -r (Join-Path $InstallDir "requirements.txt") } "pip install -r requirements.txt"

# --- 3. settings: never overwrite ------------------------------------------

if (Test-Path $Settings) {
  Write-Step "settings present: $Settings"
} else {
  Write-Step "writing $Settings (engines: $Engines)"
  Invoke-Step {
    $secret = (& $VenvPython -c "import secrets;print(secrets.token_hex(32))").Trim()
    $engineList = $Engines.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    $keepOnly = ($engineList | ForEach-Object { "      - $_" }) -join "`r`n"
    $enable = ($engineList | ForEach-Object { "  - name: $_`r`n    disabled: false" }) -join "`r`n"
    $yaml = @"
# Generated by dsh-searxng-search/scripts/bootstrap-searxng.ps1
use_default_settings:
  engines:
    keep_only:
$keepOnly

general:
  instance_name: "local-searxng"

server:
  bind_address: "$Bind"
  port: $Port
  secret_key: "$secret"
  limiter: false
  public_instance: false
  image_proxy: false

search:
  safe_search: 0
  autocomplete: ""
  default_lang: "auto"
  formats:
    - html
    - json

outgoing:
  request_timeout: 8.0
  max_request_timeout: 15.0
  pool_connections: 100
  pool_maxsize: 20
  useragent_suffix: ""

botdetection:
  ip_limit:
    enabled: false
  livecheck:
    enabled: false

engines:
$enable
"@
    Set-Content -Path $Settings -Value $yaml -Encoding UTF8
  } "write $Settings"
}

# --- 4. launcher wrapper ---------------------------------------------------

if (Test-Path $Launcher) {
  Write-Step "launcher present: $Launcher"
} else {
  Write-Step "writing $Launcher"
  Invoke-Step {
    $logs = Join-Path $InstallDir "logs"
    New-Item -ItemType Directory -Force -Path $logs | Out-Null
    $cmd = @(
      "@echo off",
      "cd /d `"$InstallDir`"",
      "set SEARXNG_SETTINGS_PATH=$Settings",
      "`"$VenvPython`" -m searx.webapp %* >> `"$logs\server.log`" 2>&1"
    ) -join "`r`n"
    Set-Content -Path $Launcher -Value $cmd -Encoding ASCII
  } "write $Launcher"
}

# --- 5. scheduled task: starts at logon, per user, no elevation -----------

Write-Step "registering scheduled task $TaskName"
Invoke-Step {
  & schtasks.exe /Create /TN $TaskName /TR "`"$Launcher`"" /SC ONLOGON /RL LIMITED /F | Out-Null
  & schtasks.exe /Run /TN $TaskName | Out-Null
} "schtasks /Create /TN $TaskName ... /SC ONLOGON, then /Run"

# --- 6. wait for health ----------------------------------------------------

if ($Print) {
  Write-Host "    would: poll $Health"
  exit 0
}

for ($i = 0; $i -lt 60; $i++) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Health -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      Write-Host ""
      Write-Host "SearXNG is up -> http://127.0.0.1:$Port (JSON API, scheduled task $TaskName)" -ForegroundColor Green
      exit 0
    }
  } catch {
    # not up yet
  }
  Start-Sleep -Seconds 1
}

Write-Warning "SearXNG did not answer $Health within 60s; see $InstallDir\logs\server.log"
exit 1
