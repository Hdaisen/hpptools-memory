#!/usr/bin/env bash
# hpptools-memory — install script (Linux/macOS)
# Installs BOTH plugins of the memory console:
#   1) hpptools-memory      — the memory backend (API + agent tools + lifecycle)
#   2) dsh-better-sidebar   — the visual panel (VSCode-style sidebar with the
#                             built-in memory tab, vendored from the
#                             DSH-better-sidebar fork under plugins/better-sidebar)
# Per plugin: symlink plugins/<pkg> -> $DSH_HOME/profiles/node_modules/<name>
#             merge the plugin row into $DSH_HOME/profiles/web/cordis.patch.yml
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILES="$DSH_HOME/profiles"
PATCH_PATH="$PROFILES/web/cordis.patch.yml"

[ -d "$PROFILES" ] || { echo "DSH profiles not found at $PROFILES" >&2; exit 1; }
echo "==> DSH_HOME: $DSH_HOME"

install_package() {
  local pkg_dir="$1" name="$2"
  [ -d "$pkg_dir" ] || { echo "plugin package not found: $pkg_dir" >&2; exit 1; }
  local dest="$PROFILES/node_modules/$name"
  if [ -e "$dest" ]; then
    echo "==> refreshing copy: $dest"
    rm -rf "$dest"
  fi
  # Copy the runtime surface only (lib + package metadata + vendored deps);
  # src / tests / build configs stay in the repo. Copying (not symlinking)
  # keeps the resolved module path inside the profile, so node_modules
  # hoisting resolves the plugin's runtime dependencies.
  mkdir -p "$dest"
  cp -r "$pkg_dir"/lib "$pkg_dir"/node_modules "$dest"/ 2>/dev/null || true
  cp -r "$pkg_dir"/*.js "$pkg_dir"/*.html "$pkg_dir"/*.json "$pkg_dir"/*.yml "$pkg_dir"/LICENSE "$dest"/ 2>/dev/null || true
  echo "==> installed $name -> $dest"
}

add_patch_row() {
  local marker="$1" rows="$2"
  if grep -q "$marker" "$PATCH_PATH" 2>/dev/null; then
    echo "==> patch already contains $marker"
    return
  fi
  if grep -qE '^\[\s*\]\s*$' "$PATCH_PATH"; then
    printf '%s\n' "$rows" > /tmp/hpptools-patch-row.yml
    sed -i -E "/^\[\s*\]\s*$/r /tmp/hpptools-patch-row.yml" "$PATCH_PATH"
    sed -i -E '/^\[\s*\]\s*$/d' "$PATCH_PATH"
    rm -f /tmp/hpptools-patch-row.yml
  else
    printf '\n%s\n' "$rows" >> "$PATCH_PATH"
  fi
  echo "==> inserted $marker row into $PATCH_PATH"
}

# 1. hpptools-memory (backend)
install_package "$REPO_ROOT/plugins/memory" "hpptools-memory"
add_patch_row "hpptools-memory" '- insert:
    - id: hpptools-memory
      name: '\''hpptools-memory'\''
      # config:
      #   root: '\''D:/my-memory'\'''

# 2. dsh-better-sidebar (visual panel, vendored fork)
install_package "$REPO_ROOT/plugins/better-sidebar" "dsh-better-sidebar"
add_patch_row "better-sidebar" '- insert:
    - id: better-sidebar
      name: '\''dsh-better-sidebar'\'''

echo
echo '==> Done. Next steps:'
echo '    1. Restart DeepSeek Harness (plugins load at startup).'
echo '    2. Verify backend: memory tools (remember/recall/memory_status/...) and injected prompt sections.'
echo '    3. Verify panel: the right sidebar workbench with the 🧠 Memory tab (Overview / Files / Models / Runs / Settings).'
echo '    4. Run /memory-clean once as a sanity check.'
