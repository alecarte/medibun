#!/usr/bin/env bash
# PreToolUse(Edit|Write|MultiEdit) guard.
#   - DENIES content containing secrets or conservative PHI-shaped data.
#   - ASKS before edits to auth / AccessPolicy / PHI-sensitive files (run security-reviewer).
#   - otherwise allows.
# Conservative by design: catch the obvious, never claim to be a full DLP. The security-reviewer
# subagent and human review are the real backstop.
set -euo pipefail

input="$(cat)"
tool="$(printf '%s' "$input" | jq -r '.tool_name // ""')"
file_path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')"

# Collect the new content across Edit (new_str), Write (file_text), MultiEdit (edits[].new_str).
content="$(printf '%s' "$input" | jq -r '
  [ .tool_input.file_text?,
    .tool_input.new_str?,
    (.tool_input.edits[]?.new_str?)
  ] | map(select(. != null)) | join("\n")
')"

deny() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}
ask() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
  exit 0
}

# Never gate the security tooling itself (these files legitimately contain the patterns).
case "$file_path" in
  */.claude/hooks/*|*/.claude/rules/*|*/.claude/agents/*) exit 0 ;;
esac

# --- DENY: secrets --------------------------------------------------------------------
if printf '%s' "$content" | grep -qE -- '-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----'; then
  deny "Blocked: a private key in file content. Secrets never live in the repo (CLAUDE.md)."
fi
if printf '%s' "$content" | grep -qE 'AKIA[0-9A-Z]{16}'; then
  deny "Blocked: AWS access key id. Use the secret manager (CLAUDE.md)."
fi
if printf '%s' "$content" | grep -qE 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.'; then
  deny "Blocked: a JWT literal in source. Don't commit tokens (CLAUDE.md)."
fi
if printf '%s' "$content" | grep -qiE '(api[_-]?key|secret|token|password|passwd|client[_-]?secret|access[_-]?key)["'"'"' ]*[:=][[:space:]]*["'"'"'][^"'"'"']{12,}["'"'"']'; then
  deny "Blocked: a hardcoded secret/credential literal. Use env + secret manager (CLAUDE.md)."
fi

# --- DENY: conservative PHI-shaped data -----------------------------------------------
# US SSN.
if printf '%s' "$content" | grep -qE '\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b'; then
  deny "Blocked: SSN-shaped value. No PHI in source/fixtures (CLAUDE.md). Use synthetic, non-PHI data."
fi
# Labeled MRN with a value.
if printf '%s' "$content" | grep -qiE '\b(mrn|medical[_-]?record[_-]?(no|number))\b["'"'"' :=]*[A-Za-z0-9-]{4,}'; then
  deny "Blocked: a populated MRN field. No PHI in source/fixtures (CLAUDE.md)."
fi
# Labeled DOB/date-of-birth with an actual date.
if printf '%s' "$content" | grep -qiE '\b(dob|date[_-]?of[_-]?birth|birth[_-]?date)\b["'"'"' :=]*[0-9]{1,4}[-/][0-9]{1,2}[-/][0-9]{1,4}'; then
  deny "Blocked: a populated date-of-birth field. No PHI in source/fixtures (CLAUDE.md)."
fi

# --- ASK: sensitive files needing security review ------------------------------------
# Match on the path (lowercased). auth, authz, access policy, permission, PHI, and Medplum/FHIR
# write-surfaces are the areas the brief routes to the security-reviewer.
lc_path="$(printf '%s' "$file_path" | tr '[:upper:]' '[:lower:]')"
case "$lc_path" in
  *auth*|*authz*|*accesspolicy*|*access-policy*|*/security/*|*permission*|*phi*|*consent*|*provenance*|*auditevent*|*audit-event*)
    ask "This edit touches auth/AccessPolicy/PHI ($file_path). Per CLAUDE.md, run the security-reviewer subagent before completing. Confirm to proceed." ;;
esac

exit 0
