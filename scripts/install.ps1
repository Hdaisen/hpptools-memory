# hpptools-memory — install script (Windows PowerShell)
# Installs BOTH plugins of the memory console:
#   1) hpptools-memory      — the memory backend (API + agent tools + lifecycle)
#   2) dsh-better-sidebar   — the visual panel (VSCode-style sidebar with the
#                             built-in memory tab, vendored from the
#                             DSH-better-sidebar fork under plugins/better-sidebar)
# Steps per plugin:
#   junction plugins/<pkg> -> <DSH_HOME>/profiles/node_modules/<name>
#   merge the plugin row into <DSH_HOME>/profiles/web/cordis.patch.yml
param(
  [string]$DshHome = $env:DSH_HOME
)
$ErrorActionPreference = 'Stop'

if (-not $DshHome) { $DshHome = Join-Path $HOME '.dsh' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$profiles = Join-Path $DshHome 'profiles'
$nodeModules = Join-Path $profiles 'node_modules'
$patchPath = Join-Path $profiles 'web\cordis.patch.yml'

if (-not (Test-Path $profiles)) { throw "DSH profiles not found at $profiles (is DSH_HOME correct?)" }
if (-not (Test-Path $patchPath)) { throw "profile patch not found: $patchPath" }

Write-Host "==> DSH_HOME: $DshHome"

# --- helper: install one package into profile node_modules -------------------
# Copies (not junction): Windows junctions resolve to the repo path at module
# resolution time, breaking dependency lookup — a copy keeps the resolved
# path inside the profile so node_modules hoisting works. Re-run the script
# to refresh a package after changes.
function Install-Package {
  param([string]$PkgDir, [string]$Name)
  if (-not (Test-Path $PkgDir)) { throw "plugin package not found: $PkgDir" }
  $dest = Join-Path $nodeModules $Name
  if (Test-Path $dest) {
    Write-Host "==> refreshing copy: $dest"
    Remove-Item $dest -Recurse -Force
  }
  # Copy the runtime surface only (lib + package metadata + vendored deps);
  # src / tests / build configs stay in the repo.
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  robocopy $PkgDir $dest /E /XD src tests docs .git .github node_modules /XF *.map *.md tsconfig*.json tsdown.config.ts /NFL /NDL /NJH /NJS /NP | Out-Null
  if (Test-Path (Join-Path $PkgDir 'node_modules')) {
    robocopy (Join-Path $PkgDir 'node_modules') (Join-Path $dest 'node_modules') /E /NFL /NDL /NJH /NJS /NP | Out-Null
  }
  Write-Host "==> installed $Name -> $dest"
}

# --- helper: merge a plugin row into cordis.patch.yml ------------------------
function Add-PatchRow {
  param([string]$Marker, [string]$Rows)
  $content = Get-Content $patchPath -Raw -Encoding UTF8
  if ($content -match $Marker) {
    Write-Host "==> patch already contains $Marker"
    return
  }
  if ($content -match '(?m)^\[\s*\]\s*$') {
    $content = $content -replace '(?m)^\[\s*\]\s*$', $Rows
  } else {
    $content = $content.TrimEnd() + "`n`n" + $Rows
  }
  Set-Content -Path $patchPath -Value $content -Encoding UTF8
  Write-Host "==> inserted $Marker row into $patchPath"
}

# --- 1. hpptools-memory (backend) -------------------------------------------
Install-Package -PkgDir (Join-Path $repoRoot 'plugins\memory') -Name 'hpptools-memory'
Add-PatchRow -Marker 'hpptools-memory' -Rows @'
- insert:
    - id: hpptools-memory
      name: 'hpptools-memory'
      # config:
      #   root: 'D:/my-memory'
'@

# --- 2. dsh-better-sidebar (visual panel, vendored fork) ---------------------
Install-Package -PkgDir (Join-Path $repoRoot 'plugins\better-sidebar') -Name 'dsh-better-sidebar'
# The vendored fork declares its own bundle patch (dsh.bundle.patch); the
# profile row mounts the package the same way the official CLI would.
Add-PatchRow -Marker 'better-sidebar' -Rows @'
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
'@

Write-Host ''
Write-Host '==> Done. Next steps:'
Write-Host '    1. Restart DeepSeek Harness (plugins load at startup).'
Write-Host '    2. Verify backend: the memory tools (remember/recall/memory_status/...) appear for the agent,'
Write-Host '       and the prompt sections "memory:core" / "memory:context" are injected.'
Write-Host '    3. Verify panel: the right sidebar shows the better-sidebar workbench,'
Write-Host '       and the "+" menu lists the 🧠 Memory tab (Overview / Files / Models / Runs / Settings).'
Write-Host '    4. Sanity check: run /memory-clean once, and `recall` an existing memory.'
