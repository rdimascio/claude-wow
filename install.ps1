# WoWGPT installer for Windows. One line, in PowerShell:
#
#   irm https://raw.githubusercontent.com/rdimascio/claude-wow/main/install.ps1 | iex
#
# Options come from the environment, since `iex` takes no parameters:
#
#   $env:WOWGPT_WOW = "D:\Games\World of Warcraft\_classic_beta_"   # the client folder (found automatically in the usual places)
#   $env:WOWGPT_PROJECT = "C:\code\my-game"                          # the default folder the agents work in
#   $env:WOWGPT_SERVICE = "yes"  (or "no")                           # start at login without asking (or never ask; an existing service is otherwise reinstalled)
#   $env:WOWGPT_SOURCE = "1"     no prebuilt binary: clone the repo and run it with Node.js 22.2+
#   $env:WOWGPT_RELEASE = "..."  which release's binary (default latest, then the newest release of any kind; a named release never falls back)
#   $env:WOWGPT_DIR = "..."      where it goes, default $env:LOCALAPPDATA\Programs\wowgpt
#   $env:WOWGPT_REF = "..."      which version of the source, from source (default main)
#
# Or download it and run:  .\install.ps1 -Wow "..." -Project "..." -Service [-FromSource]
#
# What it does, in order, and it is safe to run again (an existing install is
# updated, config.json and your chats are kept):
#   1. downloads the wowgpt binary for Windows x64 from the project's GitHub
#      releases into %LocalAppData%\Programs\wowgpt\bin, checks it against
#      the release's SHA256SUMS and runs it once. It is the bridge, setup and
#      the service commands in one file with its runtime inside: nothing else
#      to install, no Node.js. Where there is no binary (no release yet, another
#      architecture, WOWGPT_SOURCE=1) it installs from source instead, unless
#      WOWGPT_RELEASE names a release, which stops with a message:
#      checks for Node.js 22.2+, clones the repo with git (or downloads the zip;
#      nothing to npm-install) and writes a wowgpt.cmd that runs it with node
#   2. puts that folder on your user PATH (no admin rights)
#   3. runs the game-side setup (addon, config.json, slot pool, and the
#      launcher in your Startup folder that starts the bridge at login); config,
#      state and logs live in ~\.wowgpt (WOWGPT_HOME), outside the code. An
#      existing launcher (under any of the project's names) is reinstalled
#      without asking, which starts the bridge again on the new version; a
#      fresh install asks, and Enter means yes
# A claude-wow install (the name before WoWGPT) is carried over by setup,
# which copies ~\.claude-wow and replaces its launcher.
# Never asks for administrator rights. Any failure stops with a message saying what to do.

[CmdletBinding()]
param(
  [string]$Wow = (@($env:WOWGPT_WOW, $env:CLAUDE_WOW_WOW) -ne $null)[0],
  [string]$Project = (@($env:WOWGPT_PROJECT, $env:CLAUDE_WOW_PROJECT) -ne $null)[0],
  [switch]$Service,
  [switch]$NoService,
  [switch]$FromSource,
  [string]$Release = $(if ((@($env:WOWGPT_RELEASE, $env:CLAUDE_WOW_RELEASE) -ne $null)[0]) { (@($env:WOWGPT_RELEASE, $env:CLAUDE_WOW_RELEASE) -ne $null)[0] } else { 'latest' }),
  [string]$Dir = $(if ((@($env:WOWGPT_DIR, $env:CLAUDE_WOW_DIR) -ne $null)[0]) { (@($env:WOWGPT_DIR, $env:CLAUDE_WOW_DIR) -ne $null)[0] } else { Join-Path $env:LOCALAPPDATA 'Programs\wowgpt' }),
  [string]$Ref = $(if ((@($env:WOWGPT_REF, $env:CLAUDE_WOW_REF) -ne $null)[0]) { (@($env:WOWGPT_REF, $env:CLAUDE_WOW_REF) -ne $null)[0] } else { 'main' }),
  [string]$Repo = $(if ((@($env:WOWGPT_REPO, $env:CLAUDE_WOW_REPO) -ne $null)[0]) { (@($env:WOWGPT_REPO, $env:CLAUDE_WOW_REPO) -ne $null)[0] } else { 'https://github.com/rdimascio/claude-wow' })
)
# The CLAUDE_WOW_* variables from before the rename to WoWGPT still count
# when the WOWGPT_* one is not set.
Get-ChildItem Env: | Where-Object { $_.Name -like 'CLAUDE_WOW_*' } | ForEach-Object {
  $newName = 'WOWGPT_' + $_.Name.Substring('CLAUDE_WOW_'.Length)
  if (-not (Test-Path "Env:$newName")) { Set-Item "Env:$newName" $_.Value }
}
$HomeDir = $(if ($env:WOWGPT_HOME) { $env:WOWGPT_HOME } else { Join-Path $HOME '.wowgpt' })
if ($env:WOWGPT_SOURCE -eq '1') { $FromSource = $true }

$ErrorActionPreference = 'Stop'
$MinNode = [version]'22.2'

function Step($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }
function Fail($what, $fix) {
  Write-Host "`ninstall failed: $what" -ForegroundColor Red
  if ($fix) { Write-Host "  -> $fix" -ForegroundColor Yellow }
  exit 1
}
# The Startup-folder launcher under this name and the project's old ones
# (bridge/service.js dirs() and OLD_SERVICES).
$ServiceLaunchers = @('WoWGPT bridge.vbs', 'Claude WoW bridge.vbs', 'WoW AI bridge.vbs')
# What setup does about the service: -NoService and -Service (or WOWGPT_SERVICE)
# as given; an existing launcher is reinstalled without asking; a fresh
# install asks, and Enter means yes.
function Select-ServiceFlag([bool]$service, [bool]$noService, [string]$choice, [string[]]$definitions, [bool]$interactive, [scriptblock]$ask) {
  if ($noService -or $choice -eq 'no') { return '--no-service' }
  if ($service -or $choice -eq 'yes') { return '--service' }
  if (@($definitions | Where-Object { Test-Path -LiteralPath $_ }).Count) { return '--service' }
  if (-not $interactive) { return '--no-service' }
  $answer = & $ask 'Run the bridge in the background and start it at login? [Y/n]'
  if ("$answer" -match '^\s*(y|yes)?\s*$') { return '--service' }
  return '--no-service'
}
# "v22.2.0" -> is it at least $MinNode?
function Test-NodeVersion([string]$v) {
  try { return ([version]($v -replace '^v', '')) -ge $MinNode } catch { return $false }
}

function Get-NewestReleaseTag {
  if ($Repo -notmatch '^https://github\.com/(.+)$') { return $null }
  try {
    $releases = @(Invoke-RestMethod -UseBasicParsing -Headers @{ Accept = 'application/vnd.github+json' } "https://api.github.com/repos/$($Matches[1])/releases?per_page=1")
    if ($releases.Count -and $releases[0].tag_name) { return [string]$releases[0].tag_name }
  } catch {}
  return $null
}

$binDir = Join-Path $Dir 'bin'
New-Item -ItemType Directory -Force $binDir | Out-Null
$exe = Join-Path $binDir 'wowgpt.exe'
$cmdShim = Join-Path $binDir 'wowgpt.cmd'
$script:Cmd = $null

function Select-BridgeRoute([bool]$sourceWanted, [string]$release, [string]$arch, [scriptblock]$tryBinary) {
  if ($sourceWanted) { return 'source' }
  $pinned = $release -ne 'latest'
  if ($arch -ne 'AMD64') {
    if ($pinned) { return 'no-binary-for-platform' }
    Write-Host "no prebuilt binary for $arch Windows"
    return 'source'
  }
  if (& $tryBinary) { return 'binary' }
  if ($pinned) { return 'pinned-download-failed' }
  return 'source'
}

# ---- 1. The bridge ----------------------------------------------------------
function Get-Binary {
  $asset = 'wowgpt-windows-x64.exe'
  $base = if ($Release -eq 'latest') { "$Repo/releases/latest/download" } else { "$Repo/releases/download/$Release" }
  $tmp = Join-Path $env:TEMP "wowgpt-$PID.exe"
  Write-Host "downloading $base/$asset"
  try { Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile $tmp }
  catch {
    $newest = if ($Release -eq 'latest') { Get-NewestReleaseTag } else { $null }
    if (-not $newest) { Write-Host "no binary at $base/$asset (no release for it yet, or no network)"; return $false }
    $base = "$Repo/releases/download/$newest"
    Write-Host "the latest stable release has no $asset; trying the newest release, ${newest}: $base/$asset"
    try { Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile $tmp }
    catch { Write-Host "no binary at $base/$asset (no release for it yet, or no network)"; return $false }
  }
  $sums = $null
  try { $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS").Content } catch {}
  if ($sums) {
    $line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape($asset))\s*$" } | Select-Object -First 1
    $want = if ($line) { ($line -split '\s+')[0].ToLower() } else { '' }
    $have = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
    if (-not $want -or $want -ne $have) { Remove-Item -Force $tmp; Fail "the downloaded $asset does not match the release's SHA256SUMS" 'Run this again; if it keeps failing, install from source with -FromSource (or $env:WOWGPT_SOURCE = "1").' }
    Write-Host 'checksum OK'
  } else { Write-Host 'warning: the release has no SHA256SUMS, so the download was not verified' }
  & $tmp service help *> $null
  if ($LASTEXITCODE -ne 0) { Remove-Item -Force $tmp; Fail 'the downloaded binary does not run on this machine' 'Run this again with -FromSource to use Node.js instead.' }
  # Windows will not replace a running executable: stop a bridge that runs the old one first.
  if (Test-Path $exe) { & $exe service stop *> $null }
  Move-Item -Force $tmp $exe
  if (Test-Path $cmdShim) { Remove-Item -Force $cmdShim } # the source route's shim from an earlier install
  $script:Cmd = $exe
  Write-Host "wowgpt: $exe ($(& $exe --version 2>$null))"
  return $true
}

# The source route: Node.js, the code, and a .cmd shim that runs it.
function Get-Source {
  Write-Host 'installing from source'
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Fail 'Node.js is not installed (or not on the PATH), and there is no prebuilt binary to use instead' 'Install it from https://nodejs.org (the LTS installer, keep "Add to PATH" ticked) or with: winget install OpenJS.NodeJS.LTS  - then open a new PowerShell and run this again.' }
  $nodeVer = & node -v
  if (-not (Test-NodeVersion $nodeVer)) { Fail "Node.js $nodeVer is too old; $MinNode or newer is required" 'Install the current LTS from https://nodejs.org, open a new PowerShell, and run this again.' }
  Write-Host "node $nodeVer ($($node.Source))"
  $git = Get-Command git -ErrorAction SilentlyContinue
  if (Test-Path (Join-Path $Dir '.git')) {
    Write-Host "updating the existing install in $Dir"
    & git -C $Dir pull --ff-only --quiet 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Host "warning: could not fast-forward $Dir (local changes or no network); keeping what is there" -ForegroundColor Yellow } else { Write-Host "up to date with $Ref" }
  } elseif ((Test-Path $Dir) -and -not (Test-Path (Join-Path $Dir 'setup.js')) -and (Get-ChildItem $Dir -Force -Exclude bin | Select-Object -First 1)) {
    Fail "$Dir exists and is not a wowgpt install" 'Pick another folder with $env:WOWGPT_DIR, or move that one aside.'
  } elseif ($git -and -not (Test-Path (Join-Path $Dir 'setup.js'))) {
    Write-Host "cloning $Repo ($Ref) into $Dir"
    $tmpClone = Join-Path $env:TEMP "wowgpt-clone-$PID"
    & git clone --quiet --depth 1 --branch $Ref $Repo $tmpClone
    if ($LASTEXITCODE -ne 0) { Fail 'git clone failed' "Check the network and that $Repo is reachable, then run this again." }
    Copy-Item -Recurse -Force (Join-Path $tmpClone '*') $Dir
    Copy-Item -Recurse -Force (Join-Path $tmpClone '.git') $Dir
    Remove-Item -Recurse -Force $tmpClone
  } else {
    $zip = Join-Path $env:TEMP 'wowgpt.zip'
    $tmp = Join-Path $env:TEMP "wowgpt-unzip-$PID"
    Write-Host "downloading $Repo/archive/refs/heads/$Ref.zip"
    try { Invoke-WebRequest -UseBasicParsing "$Repo/archive/refs/heads/$Ref.zip" -OutFile $zip }
    catch { try { Invoke-WebRequest -UseBasicParsing "$Repo/archive/refs/tags/$Ref.zip" -OutFile $zip } catch { Fail 'download failed' 'Check the network, or install git (https://git-scm.com) and run this again.' } }
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive $zip $tmp
    $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (-not (Test-Path (Join-Path $src.FullName 'setup.js'))) { Fail 'the archive did not contain wowgpt' 'Try again with git installed.' }
    # Copy over the old files; config.json, state.json and transcripts.json are not in the archive, so they survive.
    Copy-Item -Recurse -Force (Join-Path $src.FullName '*') $Dir
    Remove-Item -Recurse -Force $tmp, $zip
    Write-Host "installed into $Dir (no git: run this script again to update)"
  }
  if (-not (Test-Path (Join-Path $Dir 'setup.js'))) { Fail "$Dir does not contain setup.js after the download" "Remove $Dir and run this again." }
  # A .cmd launcher: works from cmd and PowerShell whatever the execution policy.
  Set-Content -Path $cmdShim -Value "@echo off`r`nnode `"%~dp0..\bridge\supervisor.js`" %*`r`n" -Encoding ASCII
  if (Test-Path $exe) { & $exe service stop *> $null; Remove-Item -Force $exe } # the binary from an earlier install; .cmd is the command now
  $script:Cmd = $cmdShim
  Write-Host "wowgpt command: $cmdShim (runs $Dir with node)"
}

Step '1/3 The bridge'
switch (Select-BridgeRoute ([bool]$FromSource) $Release $env:PROCESSOR_ARCHITECTURE { Get-Binary }) {
  'source' { Get-Source }
  'no-binary-for-platform' { Fail "no wowgpt binary exists for $env:PROCESSOR_ARCHITECTURE Windows, in release $Release or any other; a pinned release never falls back to the source" "Run this again with -FromSource (or `$env:WOWGPT_SOURCE = `"1`") to run $Ref with Node.js." }
  'pinned-download-failed' { Fail "release $Release has no wowgpt binary for this machine, or it could not be downloaded; a pinned release never falls back to another release or to the source" "Check that $Repo/releases/tag/$Release exists and has wowgpt-windows-x64.exe, and check the network. Or clear `$env:WOWGPT_RELEASE for the newest release, or set `$env:WOWGPT_SOURCE = `"1`" to run $Ref with Node.js." }
}

# ---- 2. The command on the PATH ---------------------------------------------
Step '2/3 The wowgpt command'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $binDir)) {
  [Environment]::SetEnvironmentVariable('Path', (@($userPath, $binDir) -ne '' -join ';'), 'User')
  Write-Host "added $binDir to your user PATH; open a new terminal for the wowgpt command"
} else { Write-Host "$binDir is on your user PATH" }
if (-not (($env:Path -split ';') -contains $binDir)) { $env:Path = "$env:Path;$binDir" }

$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$hadService = @($ServiceLaunchers | Where-Object { Test-Path -LiteralPath (Join-Path $startupDir $_) }).Count -gt 0
$serviceFlag = Select-ServiceFlag ([bool]$Service) ([bool]$NoService) $env:WOWGPT_SERVICE @($ServiceLaunchers | ForEach-Object { Join-Path $startupDir $_ }) ([Environment]::UserInteractive) { param($q) Read-Host $q }
if ($hadService -and $serviceFlag -eq '--service') { Write-Host 'a background service is installed; setup reinstalls it so it runs this version' }

# ---- 3. Game-side setup -----------------------------------------------------
Step '3/3 Game-side setup (addon, config, slot pool, background service)'
$setupArgs = @($serviceFlag)
if ($Wow) { $setupArgs += @('--wow', $Wow) }
if ($Project) { $setupArgs += @('--project', $Project) }
& $Cmd setup @setupArgs
if ($LASTEXITCODE -ne 0) {
  Fail 'the game-side setup did not finish (see above)' 'The wowgpt command is installed. Fix what setup reported (usually: the client folder), then run:  wowgpt setup --wow "D:\path\to\World of Warcraft\_classic_beta_"'
}

if ($hadService -and $serviceFlag -eq '--no-service') { Write-Host 'The update stopped the background bridge; start it again with:  wowgpt service start' }
Write-Host "`nInstalled. The Next steps above are what is left; open a new terminal for the wowgpt command." -ForegroundColor Green
Write-Host "Update later by running this installer again (it replaces the program and restarts the service). Folder: $Dir"
