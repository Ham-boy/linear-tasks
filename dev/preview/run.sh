#!/usr/bin/env bash
# Renders the linear-tasks pane in several states and screenshots each one.
# Needs Node, Google Chrome and the claude CLI; written for Git Bash on Windows.
# Usage: bash dev/preview/run.sh   ->  dev/preview/out/<state>.png (+ .html, .json)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MOD="$(cd "$HERE/../.." && pwd)"
CLAUDE="${CLAUDE_BIN:-claude}"  # set CLAUDE_BIN if claude is not on your PATH
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
WORK="$(cygpath "$LOCALAPPDATA")/Temp/ltp"
OUT="$HERE/out"

# A copy of the mod with only the preview test, so its own tests don't run here.
rm -rf "$WORK" "$OUT"
mkdir -p "$WORK/tests" "$OUT"
cp -r "$MOD/.claude-plugin" "$MOD/hooks" "$MOD/types" "$WORK/"
[ -f "$MOD/tsconfig.json" ] && cp "$MOD/tsconfig.json" "$WORK/"
cp "$HERE/preview-states.tsx" "$WORK/tests/preview.test.tsx"

"$CLAUDE" plugin test "$WORK" > "$OUT/raw.txt" 2>&1 || true
if grep -q "(fail)" "$OUT/raw.txt"; then
  echo "PREVIEW TEST FAILED:"; grep -A3 "(fail)" "$OUT/raw.txt"
fi

for name in $(node "$HERE/render.mjs" "$OUT/raw.txt" "$OUT"); do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=480,1500 --screenshot="$(cygpath -w "$OUT/$name.png")" \
    "file:///$(cygpath -m "$OUT/$name.html")" > /dev/null 2>&1 || true
  echo "$OUT/$name.png"
done
ls "$OUT"/*.error.txt 2>/dev/null && echo "^ render refused for these states" || true
