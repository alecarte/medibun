#!/usr/bin/env bash
# Provision the LOCAL self-hosted Medplum for dev: log in as the seeded admin, create a dedicated
# REGULAR project for Medibun app users, enable its `bots` feature, create a ClientApplication, and
# write infra/medplum/.env. Idempotent-ish; re-run after `docker compose down -v`.
# LOCAL DEV ONLY — uses the well-known seeded admin password.
#
# Why a dedicated project (not the seeded "Super Admin" project): Medplum strips the refresh
# secret for super-admin logins (setLoginMembership), so brokered user logins in that project
# never get a refresh token and sessions hard-expire at the access-token lifetime. App users
# must live in a regular project.
#
# Usage: cd infra/medplum && ./setup-dev.sh
set -euo pipefail

BASE="${MEDPLUM_BASE_URL:-http://localhost:8103}"
BASE="${BASE%/}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT_NAME="Medibun Dev"

# Helper: PKCE login for a given body, echo "<loginId> <code>" (code may be empty).
pkce_login() {
  local body_extra="$1"
  local v ch
  v="$(openssl rand -base64 60 | tr -d '\n=+/' | cut -c1-64)"
  ch="$(printf '%s' "$v" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=\n')"
  local resp
  resp="$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"admin@example.com\",\"password\":\"medplum_admin\",\"codeChallenge\":\"$ch\",\"codeChallengeMethod\":\"S256\"$body_extra}")"
  echo "$v $(printf '%s' "$resp" | jq -r '.login // empty') $(printf '%s' "$resp" | jq -r '.code // empty')"
}

# Exchange a PKCE code for an access token.
exchange() { # <verifier> <code>
  curl -s -X POST "$BASE/oauth2/token" -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "grant_type=authorization_code" --data-urlencode "code=$2" \
    --data-urlencode "code_verifier=$1" | jq -r '.access_token'
}

# Create (or reuse) a dedicated REGULAR project for Medibun app users, owned by the seeded admin.
#
# Why a dedicated project (not the seeded "Super Admin" project): Medplum strips the refresh secret
# for super-admin logins (setLoginMembership), so brokered user logins there never get a refresh
# token. App users must live in a regular project.
#
# Why /auth/newproject (not a super-admin `POST /fhir/R4/Project`): a directly-written Project
# resource leaves the admin a non-member, so subsequent `/admin/projects/{pid}/*` calls resolve to
# the admin's OWN (super-admin) project instead — the bot's ProjectMembership lands in the wrong
# project and $deploy fails "Not found". /auth/newproject makes the creator the project OWNER, so
# admin endpoints (and the owner access token below) operate inside the new project correctly.
echo "→ logging in as seeded admin to look for an existing '$PROJECT_NAME'…"
read -r SAV _SAL SAC < <(pkce_login "")
SADMIN="$(exchange "$SAV" "$SAC")"
[ -n "$SADMIN" ] && [ "$SADMIN" != "null" ] || { echo "✗ admin login failed"; exit 1; }

PID="$(curl -s "$BASE/fhir/R4/Project?name=Medibun%20Dev" \
  -H "Authorization: Bearer $SADMIN" | jq -r '.entry[0].resource.id // empty')"

if [ -z "$PID" ]; then
  echo "→ creating regular project '$PROJECT_NAME' via /auth/newproject…"
  # A login scoped to projectId:"new" is membership-less, which /auth/newproject requires.
  read -r NV NLOGIN _NC < <(pkce_login ",\"projectId\":\"new\",\"scope\":\"openid\"")
  [ -n "$NLOGIN" ] && [ "$NLOGIN" != "null" ] || { echo "✗ could not get a membership-less login"; exit 1; }
  NPCODE="$(curl -s -X POST "$BASE/auth/newproject" -H 'Content-Type: application/json' \
    -d "{\"login\":\"$NLOGIN\",\"projectName\":\"$PROJECT_NAME\"}" | jq -r '.code')"
  [ -n "$NPCODE" ] && [ "$NPCODE" != "null" ] || { echo "✗ newproject failed"; exit 1; }
  ACCESS="$(exchange "$NV" "$NPCODE")"
else
  # Existing project: log back in scoped to it to get an owner token for admin calls.
  echo "→ reusing project; logging in scoped to it…"
  read -r RV _RL RC < <(pkce_login ",\"projectId\":\"$PID\",\"scope\":\"openid\"")
  ACCESS="$(exchange "$RV" "$RC")"
fi
[ -n "$ACCESS" ] && [ "$ACCESS" != "null" ] || { echo "✗ owner login for project failed"; exit 1; }
PID="$(curl -s "$BASE/auth/me" -H "Authorization: Bearer $ACCESS" | jq -r '.project.id')"
[ -n "$PID" ] && [ "$PID" != "null" ] || { echo "✗ could not resolve project id"; exit 1; }
echo "→ project: $PID"

# The `features` array is super-admin-only to edit, so use the seeded-admin (super-admin) token
# here even though everything else runs as the project owner.
echo "→ enabling 'bots' project feature (super-admin)…"
PROJ="$(curl -s "$BASE/fhir/R4/Project/$PID" -H "Authorization: Bearer $SADMIN")"
UPDATED="$(printf '%s' "$PROJ" | jq '.features = ((.features // []) + ["bots"] | unique)')"
curl -s -X PUT "$BASE/fhir/R4/Project/$PID" -H "Authorization: Bearer $SADMIN" \
  -H 'Content-Type: application/fhir+json' -d "$UPDATED" | jq -e '.features | index("bots")' >/dev/null \
  && echo "  ✓ bots enabled" || { echo "  ✗ failed to enable bots"; exit 1; }

echo "→ creating ClientApplication 'medibun-backend-dev'…"
CREATED="$(curl -s -X POST "$BASE/admin/projects/$PID/client" -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -d '{"name":"medibun-backend-dev","description":"Dev client for @medibun/medplum-backend"}')"
CID="$(printf '%s' "$CREATED" | jq -r '.id')"
CSECRET="$(printf '%s' "$CREATED" | jq -r '.secret')"
[ -n "$CSECRET" ] && [ "$CSECRET" != "null" ] || { echo "✗ client create failed: $CREATED"; exit 1; }

# Set refreshTokenLifetime to bound the refresh token's life (docs/AUTH.md target: 30d).
# NOTE: the actual gate for whether a refresh token is ISSUED is (a) `offline_access` in the
# login scope and (b) a non-super-admin project (super-admin logins have their refresh secret
# stripped) — both handled above. This field only controls the token's lifetime once issued.
echo "→ setting refreshTokenLifetime on the client…"
CLIENT_RES="$(curl -s "$BASE/fhir/R4/ClientApplication/$CID" -H "Authorization: Bearer $ACCESS")"
CLIENT_UPD="$(printf '%s' "$CLIENT_RES" | jq '.refreshTokenLifetime = "30d"')"
curl -s -X PUT "$BASE/fhir/R4/ClientApplication/$CID" -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/fhir+json' -d "$CLIENT_UPD" \
  | jq -e '.refreshTokenLifetime == "30d"' >/dev/null \
  && echo "  ✓ refreshTokenLifetime=30d" || { echo "  ✗ failed to set refreshTokenLifetime"; exit 1; }

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

# Invite a SYNTHETIC patient user so the brokered-login flow is exercisable out of the box.
# Synthetic, non-PHI; LOCAL DEV ONLY. Ignored if the email already exists (idempotent re-runs).
echo "→ inviting synthetic patient 'synthia.login@example.test'…"
curl -s -X POST "$BASE/admin/projects/$PID/invite" -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -d '{"resourceType":"Patient","firstName":"Synthia","lastName":"Loginsmith","email":"synthia.login@example.test","password":"synth-pw-12345","sendEmail":false}' \
  >/dev/null && echo "  ✓ synthetic patient ready (synthia.login@example.test / synth-pw-12345)"

cat > "$HERE/.env" <<EOF
MEDPLUM_BASE_URL=$BASE/
MEDPLUM_CLIENT_ID=$CID
MEDPLUM_CLIENT_SECRET=$CSECRET
MEDPLUM_BOT_ID=$BID
MEDPLUM_PROJECT_ID=$PID

# Experience DB + auth (apps/api). Synthetic local dev only — see .env.example.
EXPERIENCE_DATABASE_URL=postgres://medibun:medibun@localhost:5433/medibun_experience
SESSION_ENCRYPTION_KEY=$(openssl rand -base64 32)
API_COOKIE_INSECURE_DEV=1
EOF
echo "✓ wrote $HERE/.env (gitignored). Client: $CID  Bot: $BID  Project: $PID"

echo "→ migrating experience db…"
(cd "$HERE/../.." && pnpm --filter @medibun/api db:migrate) \
  && echo "  ✓ experience db migrated" \
  || { echo "✗ experience db migration failed"; exit 1; }
