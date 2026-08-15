# hpptools-memory — install script (Windows PowerShell)
# 1) junction plugins/memory -> <DSH_HOME>/profiles/node_modules/hpptools-memory
# 2) merge the plugin row into <DSH_HOME>/profiles/web/cordis.patch.yml
# 3) print next steps (restart DeepSeek Harness to load the plugin)
param(
  [string]$DshHome = $env:DSH_HOME
)
$ErrorActionPreference = 'Stop'

if (-not $DshHome) { $DshHome = Join-Path $HOME '.dsh' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$pkgDir = Join-Path $repoRoot 'plugins\memory'
$profiles = Join-Path $DshHome 'profiles'
$nodeModules = Join-Path $profiles 'node_modules'
$patchPath = Join-Path $profiles 'web\cordis.patch.yml'

if (-not (Test-Path $pkgDir)) { throw "plugin package not found: $pkgDir" }
if (-not (Test-Path $profiles)) { throw "DSH profiles not found at $profiles (is DSH_HOME correct?)" }

Write-Host "==> DSH_HOME: $DshHome"

# --- 1. link package into profile node_modules -------------------------------
$linkPath = Join-Path $nodeModules 'hpptools-memory'
if (Test-Path $linkPath) {
  Write-Host "==> package already linked: $linkPath"
} else {
  New-Item -ItemType Junction -Path $linkPath -Target $pkgDir | Out-Null
  Write-Host "==> linked $linkPath -> $pkgDir"
}

# --- 2. merge plugin row into cordis.patch.yml -------------------------------
if (-not (Test-Path $patchPath)) {
  throw "profile patch not found: $patchPath"
}
$content = Get-Content $patchPath -Raw -Encoding UTF8
if ($content -match 'hpptools-memory') {
  Write-Host "==> patch already contains hpptools-memory: $patchPath"
} else {
  $rows = @'
- insert:
    - id: hpptools-memory
      name: 'hpptools-memory'
      # config:
      #   root: 'D:/my-memory'
'@
  # The user patch file is a top-level YAML array; replace the empty '[]' marker.
  if ($content -match '(?m)^\[\s*\]\s*$') {
    $content = $content -replace '(?m)^\[\s*\]\s*$', $rows
  } else {
    $content = $content.TrimEnd() + "`n`n" + $rows
  }
  Set-Content -Path $patchPath -Value $content -Encoding UTF8
  Write-Host "==> inserted plugin row into $patchPath"
}

Write-Host ''
Write-Host '==> Done. Next steps:'
Write-Host '    1. Restart DeepSeek Harness (plugins load at startup).'
Write-Host '    2. Verify: the memory tools (remember/recall/memory_status/...) appear for the agent,'
Write-Host '       and the prompt sections "memory:core" / "memory:context" are injected.'
Write-Host '    3. Sanity check: run /memory-clean once, and `recall` an existing memory.'
