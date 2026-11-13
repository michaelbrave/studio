# Install Studio on Windows, from a clone of the repository. In a normal (not administrator)
# PowerShell, in this folder:
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1            ask before each download
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Yes       don't ask
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Service   also start Studio at login
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall remove the `studio` command
#
# The same steps as install.sh, skipping anything already done:
#   1. Node >= 22.18: yours if it's new enough, else the official build in %LOCALAPPDATA%\studio\node.
#   2. T3 Code at the version in T3_VERSION, with T3's own installer (into ~\.t3).
#   3. Studio's packages (npm ci).
#   4. The `studio` command: ~\.local\bin\studio.cmd, and that folder on your user PATH.
#   5. A check for agent CLIs (Claude Code, Codex, OpenCode); signing in to them is up to you.
param([switch]$Yes, [switch]$Service, [switch]$Uninstall)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" # Invoke-WebRequest is very slow with the progress bar

$StudioDir = $PSScriptRoot
$BinDir = Join-Path $HOME ".local\bin"
$NodeDir = Join-Path $env:LOCALAPPDATA "studio\node"
$NodeMin = [version]"22.18.0"
$T3Pin = (Get-Content (Join-Path $StudioDir "T3_VERSION") -Raw).Trim()
$Launcher = Join-Path $BinDir "studio.cmd"

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Green }
function Note($m) { Write-Host "    $m" }
function Fail($m) { Write-Host "install.ps1: $m" -ForegroundColor Red; exit 1 }
function Ask($q) {
  if ($Yes) { return $true }
  $r = Read-Host "    $q [Y/n]"
  return ($r -eq "" -or $r -match "^[Yy]")
}
function NodeVersion($exe) {
  try { return [version](& $exe -p "process.versions.node") } catch { return $null }
}

if ($Uninstall) {
  if (Test-Path $Launcher) { Remove-Item $Launcher }
  Write-Host "Removed the 'studio' command. Still here, remove by hand if you want:"
  Write-Host "  $HOME\.config\studio  (hub database, worker sign-ins, vault)"
  Write-Host "  $NodeDir  (Studio's Node, if this script downloaded one)"
  Write-Host "  T3 Code: ~\.t3 and ~\.local\bin\t3.cmd. Login task: run 'studio service off' first."
  exit 0
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail "git is required (agents work in git worktrees). Install it with: winget install Git.Git"
}
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }

# ---------------------------------------------------------------- 1. Node
Step "Node >= $NodeMin"
$node = $null
$studioNode = Join-Path $NodeDir "node.exe"
if ((Test-Path $studioNode) -and (NodeVersion $studioNode) -ge $NodeMin) {
  $node = $studioNode
} elseif ((Get-Command node -ErrorAction SilentlyContinue) -and (NodeVersion "node") -ge $NodeMin) {
  $node = (Get-Command node).Source
}
if ($node) {
  Note "using $node (v$(NodeVersion $node))"
} else {
  if (Get-Command node -ErrorAction SilentlyContinue) { Note "found Node v$(NodeVersion 'node'), which is too old for Studio" }
  if (-not (Ask "Download Node 22 (official build) into $NodeDir?")) { Fail "install Node >= $NodeMin yourself, then re-run" }
  $base = "https://nodejs.org/dist/latest-v22.x"
  $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content -split "`n"
  $line = $sums | Where-Object { $_ -match "\s(node-v22\.[0-9.]+-win-$arch\.zip)$" } | Select-Object -First 1
  if (-not $line) { Fail "no Node 22 build for win-$arch" }
  $want, $file = $line.Trim() -split "\s+"
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("studio-" + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory $tmp | Out-Null
  try {
    Note "downloading $file"
    Invoke-WebRequest "$base/$file" -OutFile (Join-Path $tmp $file) -UseBasicParsing
    $got = (Get-FileHash (Join-Path $tmp $file) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($got -ne $want) { Fail "checksum mismatch for $file" }
    Expand-Archive (Join-Path $tmp $file) -DestinationPath $tmp -Force
    if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
    New-Item -ItemType Directory -Force (Split-Path $NodeDir) | Out-Null
    Move-Item (Join-Path $tmp ($file -replace "\.zip$", "")) $NodeDir
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  $node = $studioNode
  Note "installed v$(NodeVersion $node) (only Studio uses it)"
}
$env:Path = "$(Split-Path $node);$env:Path"

# ---------------------------------------------------------------- 2. T3 Code
Step "T3 Code $T3Pin"
if (($env:Path -split ";") -notcontains $BinDir) { $env:Path = "$env:Path;$BinDir" }
$have = $null
if (Get-Command t3 -ErrorAction SilentlyContinue) {
  $have = ((& t3 --version 2>$null) | Select-String -Pattern "\d+\.\d+\.\d+").Matches.Value | Select-Object -First 1
}
if ($have -eq $T3Pin) {
  Note "already installed ($((Get-Command t3).Source))"
} else {
  if ($have) { Note "found T3 $have; Studio is tested with $T3Pin" }
  if (Ask "Install T3 $T3Pin with T3's installer (https://t3.codes/install.ps1)? Your projects and settings in ~\.t3 stay.") {
    $script = Join-Path ([System.IO.Path]::GetTempPath()) "t3-install-$([System.IO.Path]::GetRandomFileName()).ps1"
    try {
      Invoke-WebRequest "https://t3.codes/install.ps1" -OutFile $script -UseBasicParsing
      $env:T3CODE_VERSION = $T3Pin
      & powershell -NoProfile -ExecutionPolicy Bypass -File $script
      if ($LASTEXITCODE -ne 0) { Fail "T3's installer failed" }
    } finally {
      Remove-Item $script -ErrorAction SilentlyContinue
      Remove-Item Env:T3CODE_VERSION -ErrorAction SilentlyContinue
    }
  } elseif (-not $have) {
    Fail "Studio needs T3 Code. Install it from https://t3.codes, then re-run"
  } else {
    Note "keeping T3 $have"
  }
}

# ---------------------------------------------------------------- 3. packages
Step "Studio packages"
Push-Location $StudioDir
try {
  $env:npm_config_update_notifier = "false"
  & npm ci --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Fail "npm ci failed" }
} finally { Pop-Location }

# ---------------------------------------------------------------- 4. command
Step "The 'studio' command"
New-Item -ItemType Directory -Force $BinDir | Out-Null
$target = Join-Path $StudioDir "bin\studio.cmd"
[System.IO.File]::WriteAllText($Launcher, "@echo off`r`n`"$target`" %*`r`n", (New-Object System.Text.UTF8Encoding $false))
Note "$Launcher -> $target"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ((($userPath -split ";") | ForEach-Object { $_.TrimEnd('\') }) -notcontains $BinDir.TrimEnd('\')) {
  [Environment]::SetEnvironmentVariable("Path", ($(if ($userPath) { "$userPath;" } else { "" }) + $BinDir), "User")
  Note "added $BinDir to your user PATH (new terminals will see it)"
}

# ---------------------------------------------------------------- 5. agents
Step "Agent CLIs (T3 runs these; you need at least one, signed in)"
$any = $false
foreach ($a in @(
    @("claude", "Claude Code", "https://claude.com/product/claude-code", "claude auth login"),
    @("codex", "Codex", "https://developers.openai.com/codex/cli", "codex login"),
    @("opencode", "OpenCode", "https://opencode.ai", "free models need no login"))) {
  if (Get-Command $a[0] -ErrorAction SilentlyContinue) { Note "OK  $($a[1])"; $any = $true }
  else { Note "--  $($a[1]) not found: $($a[2]) ($($a[3]))" }
}
if (-not $any) { Write-Host "    Install at least one before starting a job." -ForegroundColor Yellow }

if ($Service) {
  Step "Start at login"
  & $Launcher service on
}

Write-Host "`nStudio is installed." -ForegroundColor Green
Write-Host @"

    studio                 start Studio (and T3 under it) and open it in the browser
    studio service on      start it at every login instead
    studio lan on          use it from other computers on your network
    studio doctor          check the setup

Open a new terminal first so it finds the 'studio' command.
"@
