#!/usr/bin/env bash
# Provision the LOCAL self-hosted Medplum for dev: log in as the seeded admin, enable the project's
# `bots` feature, create a ClientApplication, and write infra/medplum/.env. Idempotent-ish; re-run
# after `docker compose down -v`. LOCAL DEV ONLY — uses the well-known seeded admin password.
#
# Usage: cd infra/medplum && ./setup-dev.sh
set -euo pipefail

BASE="${MEDPLUM_BASE_URL:-http://localhost:8103}"
BASE="${BASE%/}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "→ logging in as seeded admin (PKCE)…"
VERIFIER="$(openssl rand -base64 60 | tr -d '\n=+/' | cut -c1-64)"
CHALLENGE="$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=\n')"
CODE="$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@example.com\",\"password\":\"medplum_admin\",\"codeChallenge\":\"$CHALLENGE\",\"codeChallengeMethod\":\"S256\"}" \
  | jq -r '.code')"
ACCESS="$(curl -s -X POST "$BASE/oauth2/token" -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "grant_type=authorization_code" --data-urlencode "code=$CODE" --data-urlencode "code_verifier=$VERIFIER" \
  | jq -r '.access_token')"
[ -n "$ACCESS" ] && [ "$ACCESS" != "null" ] || { echo "✗ admin login failed"; exit 1; }

PID="$(curl -s "$BASE/auth/me" -H "Authorization: Bearer $ACCESS" | jq -r '.project.id')"
echo "→ project: $PID"

echo "→ enabling 'bots' project feature…"
PROJ="$(curl -s "$BASE/fhir/R4/Project/$PID" -H "Authorization: Bearer $ACCESS")"
UPDATED="$(printf '%s' "$PROJ" | jq '.features = ((.features // []) + ["bots"] | unique)')"
curl -s -X PUT "$BASE/fhir/R4/Project/$PID" -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/fhir+json' -d "$UPDATED" | jq -e '.features | index("bots")' >/dev/null \
  && echo "  ✓ bots enabled" || { echo "  ✗ failed to enable bots"; exit 1; }

echo "→ creating ClientApplication 'medibun-backend-dev'…"
CREATED="$(curl -s -X POST "$BASE/admin/projects/$PID/client" -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -d '{"name":"medibun-backend-dev","description":"Dev client for @medibun/medplum-backend"}')"
CID="$(printf '%s' "$CREATED" | jq -r '.id')"
CSECRET="$(printf '%s' "$CREATED" | jq -r '.secret')"
[ -n "$CSECRET" ] && [ "$CSECRET" != "null" ] || { echo "✗ client create failed: $CREATED"; exit 1; }

# Create the bot via the ADMIN endpoint so it gets a ProjectMembership (required to execute).
# Creating a Bot via the plain FHIR API would have no membership → "Could not find project
# membership for bot" at execution time. The verify script then deploys its code + subscribes.
echo "→ creating Bot 'hello-world-bot' (with membership)…"
BOT="$(curl -s -X POST "$BASE/admin/projects/$PID/bot" -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -d '{"name":"hello-world-bot","description":"Step-5 hello-world bot","runtimeVersion":"vmcontext"}')"
BID="$(printf '%s' "$BOT" | jq -r '.id')"
[ -n "$BID" ] && [ "$BID" != "null" ] || { echo "✗ bot create failed: $BOT"; exit 1; }
echo "  ✓ bot: $BID"

cat > "$HERE/.env" <<EOF
MEDPLUM_BASE_URL=$BASE/
MEDPLUM_CLIENT_ID=$CID
MEDPLUM_CLIENT_SECRET=$CSECRET
MEDPLUM_BOT_ID=$BID
EOF
echo "✓ wrote $HERE/.env (gitignored). Client: $CID  Bot: $BID"
