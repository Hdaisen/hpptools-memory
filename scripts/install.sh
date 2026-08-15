#!/usr/bin/env bash
# hpptools-memory — install script (Linux/macOS)
# 1) symlink plugins/memory -> $DSH_HOME/profiles/node_modules/hpptools-memory
# 2) merge the plugin row into $DSH_HOME/profiles/web/cordis.patch.yml
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$REPO_ROOT/plugins/memory"
PROFILES="$DSH_HOME/profiles"
PATCH_PATH="$PROFILES/web/cordis.patch.yml"

[ -d "$PKG_DIR" ] || { echo "plugin package not found: $PKG_DIR" >&2; exit 1; }
[ -d "$PROFILES" ] || { echo "DSH profiles not found at $PROFILES" >&2; exit 1; }
echo "==> DSH_HOME: $DSH_HOME"

# 1. link package
LINK_PATH="$PROFILES/node_modules/hpptools-memory"
if [ -e "$LINK_PATH" ]; then
  echo "==> package already linked: $LINK_PATH"
else
  ln -s "$PKG_DIR" "$LINK_PATH"
  echo "==> linked $LINK_PATH -> $PKG_DIR"
fi

# 2. merge plugin row
if grep -q 'hpptools-memory' "$PATCH_PATH" 2>/dev/null; then
  echo "==> patch already contains hpptools-memory: $PATCH_PATH"
else
  ROWS='- insert:
    - id: hpptools-memory
      name: '\''hpptools-memory'\''
      config:
        root: '\''~/.pi/agent/memory'\'''
  if grep -qE '^\[\s*\]\s*$' "$PATCH_PATH"; then
    sed -i -E 's/^\[\s*\]\s*$/- insert:\n    - id: hpptools-memory\n      name: '\''hpptools-memory'\''\n      config:\n        root: '\''~\/.pi\/agent\/memory'\''/' "$PATCH_PATH"
  else
    printf '\n%s\n' "$ROWS" >> "$PATCH_PATH"
  fi
  echo "==> inserted plugin row into $PATCH_PATH"
fi

echo
echo '==> Done. Next steps:'
echo '    1. Restart DeepSeek Harness (plugins load at startup).'
echo '    2. Verify memory tools and injected prompt sections.'
echo '    3. Run /memory-clean once as a sanity check.'
