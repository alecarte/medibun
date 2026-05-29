#!/usr/bin/env bash
# PreToolUse(Bash) guard. Reads the hook JSON on stdin, inspects the command, and:
#   - DENIES clearly destructive / irreversible commands (CLAUDE.md: never auto-execute these)
#   - ASKS before commands that discard uncommitted work
#   - otherwise allows.
# Emits a PreToolUse permission decision as JSON on stdout (exit 0).
set -euo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""')"

deny() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}
ask() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
  exit 0
}

# --- DENY: destructive / irreversible -------------------------------------------------
# Recursive force-remove.
if printf '%s' "$cmd" | grep -qE '\brm[[:space:]]+(-[A-Za-z]*[rf][A-Za-z]*[[:space:]]+)+'; then
  deny "Blocked: recursive/forced 'rm'. Destructive deletes require explicit human action (CLAUDE.md)."
fi
# Force-push to a remote.
if printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+push\b.*(--force([[:space:]]|=|$)|--force-with-lease|[[:space:]]-f([[:space:]]|$))'; then
  deny "Blocked: git force-push. Requires explicit human action (CLAUDE.md: irreversible/prod-affecting)."
fi
# Destructive SQL / DB teardown.
if printf '%s' "$cmd" | grep -qiE '\b(drop[[:space:]]+(table|database|schema)|truncate[[:space:]]+table|delete[[:space:]]+from[[:space:]]+[^;]*$)'; then
  deny "Blocked: destructive SQL. Schema/data teardown is a human-approval, migration-reviewed action (CLAUDE.md)."
fi
if printf '%s' "$cmd" | grep -qiE '(db|database|prisma|drizzle|knex|sequelize)[[:space:]:]+.*(drop|reset|migrate[[:space:]:-]+down|wipe)'; then
  deny "Blocked: database reset/down-migration. Requires human approval + migration review (CLAUDE.md)."
fi
# Piping the network straight into a shell.
if printf '%s' "$cmd" | grep -qE '(curl|wget)[[:space:]].*\|[[:space:]]*(sudo[[:space:]]+)?(ba)?sh'; then
  deny "Blocked: piping a downloaded script into a shell. Inspect and run deliberately instead."
fi
# Classic footguns.
if printf '%s' "$cmd" | grep -qE ':\(\)[[:space:]]*\{[[:space:]]*:\|:&[[:space:]]*\};:|[[:space:]]mkfs(\.|[[:space:]])|[[:space:]]dd[[:space:]].*of=/dev/'; then
  deny "Blocked: fork bomb / raw disk write / mkfs."
fi
# Recursive perm/ownership changes on home or root.
if printf '%s' "$cmd" | grep -qE '\b(chmod|chown)[[:space:]]+(-[A-Za-z]*R[A-Za-z]*[[:space:]]+).*(/|~|\$HOME)([[:space:]]|$)'; then
  deny "Blocked: recursive chmod/chown on / or home."
fi

# --- ASK: discards uncommitted work ---------------------------------------------------
if printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+reset[[:space:]]+--hard\b'; then
  ask "git reset --hard discards uncommitted changes. Confirm to proceed."
fi
if printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+(checkout|restore)[[:space:]]+(--[[:space:]]+)?\.([[:space:]]|$)|\bgit[[:space:]]+clean[[:space:]]+-[A-Za-z]*[fdx]'; then
  ask "This discards uncommitted/untracked changes. Confirm to proceed."
fi

# Allow everything else.
exit 0
