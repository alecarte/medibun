#!/usr/bin/env bash
# PostToolUse(Edit|Write|MultiEdit) verify. Scoped to the edited file's workspace package:
# runs that package's typecheck + lint (NOT the full test suite — tests run at task boundaries).
# Skips non-code edits. On failure: exit 2 + stderr so the model sees and fixes the breakage.
# Advisory: the edit already happened; this is fast feedback, not a block.
set -uo pipefail

input="$(cat)"
file_path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')"
[ -n "$file_path" ] || exit 0

# Only verify TypeScript/JS source edits.
case "$file_path" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# Find the nearest package.json above the edited file, up to the repo root → its package name.
dir="$(dirname "$file_path")"
pkg_name=""
while [ "$dir" != "/" ] && [ "$dir" != "." ]; do
  if [ -f "$dir/package.json" ]; then
    name="$(jq -r '.name // ""' "$dir/package.json" 2>/dev/null)"
    # Skip the private root package (name "medibun") — keep walking to a workspace package.
    if [ -n "$name" ] && [ "$name" != "medibun" ]; then
      pkg_name="$name"
      break
    fi
  fi
  [ "$dir" = "$root" ] && break
  dir="$(dirname "$dir")"
done

[ -n "$pkg_name" ] || exit 0  # edit outside a workspace package → nothing scoped to run

cd "$root" || exit 0

out="$(pnpm --filter "$pkg_name" run --if-present typecheck 2>&1)"; tc=$?
lint_out="$(pnpm --filter "$pkg_name" run --if-present lint 2>&1)"; ln=$?

if [ "$tc" -ne 0 ] || [ "$ln" -ne 0 ]; then
  {
    echo "PostToolUse verify failed for package '$pkg_name' (edited: $file_path)."
    [ "$tc" -ne 0 ] && { echo "--- typecheck ---"; printf '%s\n' "$out" | tail -25; }
    [ "$ln" -ne 0 ] && { echo "--- lint ---"; printf '%s\n' "$lint_out" | tail -25; }
    echo "Fix these before considering the change done (CLAUDE.md definition of done)."
  } >&2
  exit 2
fi

exit 0
