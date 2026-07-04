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

# Preflight: fail fast with the fix instead of "command not found" mid-provisioning.
for cmd in jq curl openssl docker; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "✗ missing dependency: $cmd"
    [ "$cmd" = "jq" ] && echo "  fix: sudo apt-get install -y jq (or brew install jq)"
    exit 1
  }
done

BASE="${MEDPLUM_BASE_URL:-http://localhost:8103}"
BASE="${BASE%/}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT_NAME="Medibun Dev"

# Helper: PKCE login for a given body; echoes "<verifier> <loginId> <code> <superAdminMembershipId>"
# with '-' for absent fields (empty fields would shift under word-splitting `read`).
# The 4th field exists because a bare login for a user with MULTIPLE memberships returns
# `{login, memberships}` and NO code (v5.1.9 sendLoginResult) — the caller must then select
# a profile via /auth/profile to get the code.
pkce_login() {
  local body_extra="$1"
  local v ch
  v="$(openssl rand -base64 60 | tr -d '\n=+/' | cut -c1-64)"
  ch="$(printf '%s' "$v" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=\n')"
  local resp
  resp="$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"admin@example.com\",\"password\":\"medplum_admin\",\"codeChallenge\":\"$ch\",\"codeChallengeMethod\":\"S256\"$body_extra}")"
  echo "$v" \
    "$(printf '%s' "$resp" | jq -r '.login // "-"')" \
    "$(printf '%s' "$resp" | jq -r '.code // "-"')" \
    "$(printf '%s' "$resp" | jq -r '[.memberships[]? | select(.project.display == "Super Admin")][0].id // "-"')"
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
read -r SAV SALOGIN SAC SAMID < <(pkce_login "")
if [ "$SAC" = "-" ] && [ "$SALOGIN" != "-" ]; then
  # Re-run path: this script's project is OWNED by the same seeded admin, so after the first
  # run the admin has 2+ memberships and the bare login returns no code — select the
  # Super Admin profile explicitly (the canonical /auth/profile step the app UI performs).
  [ "$SAMID" != "-" ] || { echo "✗ admin has multiple memberships but none in 'Super Admin'"; exit 1; }
  echo "  (admin has multiple memberships — selecting the Super Admin profile)"
  SAC="$(curl -s -X POST "$BASE/auth/profile" -H 'Content-Type: application/json' \
    -d "{\"login\":\"$SALOGIN\",\"profile\":\"$SAMID\"}" | jq -r '.code // "-"')"
fi
[ "$SAC" != "-" ] && [ -n "$SAC" ] || { echo "✗ admin login failed"; exit 1; }
SADMIN="$(exchange "$SAV" "$SAC")"
[ -n "$SADMIN" ] && [ "$SADMIN" != "null" ] || { echo "✗ admin login failed"; exit 1; }

PID="$(curl -s "$BASE/fhir/R4/Project?name=Medibun%20Dev" \
  -H "Authorization: Bearer $SADMIN" | jq -r '.entry[0].resource.id // empty')"

if [ -z "$PID" ]; then
  echo "→ creating regular project '$PROJECT_NAME' via /auth/newproject…"
  # A login scoped to projectId:"new" is membership-less, which /auth/newproject requires.
  read -r NV NLOGIN _NC _NM < <(pkce_login ",\"projectId\":\"new\",\"scope\":\"openid\"")
  [ "$NLOGIN" != "-" ] || { echo "✗ could not get a membership-less login"; exit 1; }
  NPCODE="$(curl -s -X POST "$BASE/auth/newproject" -H 'Content-Type: application/json' \
    -d "{\"login\":\"$NLOGIN\",\"projectName\":\"$PROJECT_NAME\"}" | jq -r '.code')"
  [ -n "$NPCODE" ] && [ "$NPCODE" != "null" ] || { echo "✗ newproject failed"; exit 1; }
  ACCESS="$(exchange "$NV" "$NPCODE")"
else
  # Existing project: log back in scoped to it to get an owner token for admin calls.
  # (Scoped logins have a single candidate membership, so a code always comes back.)
  echo "→ reusing project; logging in scoped to it…"
  read -r RV _RL RC _RM < <(pkce_login ",\"projectId\":\"$PID\",\"scope\":\"openid\"")
  [ "$RC" != "-" ] || { echo "✗ project-scoped login returned no code"; exit 1; }
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

# Upsert the patient-compartment AccessPolicy template (docs/DATA_MODEL.md matrix; approved
# via docs/V0_PROPOSAL.md A3). Policies land via reviewed code only — never the admin UI.
echo "→ upserting AccessPolicy 'patient-self-v1'…"
POLICY_SRC="$(cat "$HERE/policies/patient-self.json")"
EXISTING_POLICY_ID="$(curl -s "$BASE/fhir/R4/AccessPolicy?name=patient-self-v1" \
  -H "Authorization: Bearer $ACCESS" | jq -r '.entry[0].resource.id // empty')"
if [ -n "$EXISTING_POLICY_ID" ]; then
  POLICY_ID="$EXISTING_POLICY_ID"
  curl -s -X PUT "$BASE/fhir/R4/AccessPolicy/$POLICY_ID" -H "Authorization: Bearer $ACCESS" \
    -H 'Content-Type: application/fhir+json' \
    -d "$(printf '%s' "$POLICY_SRC" | jq --arg id "$POLICY_ID" '. + {id: $id}')" \
    | jq -e '.id' >/dev/null || { echo "✗ policy update failed"; exit 1; }
else
  POLICY_ID="$(curl -s -X POST "$BASE/fhir/R4/AccessPolicy" -H "Authorization: Bearer $ACCESS" \
    -H 'Content-Type: application/fhir+json' -d "$POLICY_SRC" | jq -r '.id')"
  [ -n "$POLICY_ID" ] && [ "$POLICY_ID" != "null" ] || { echo "✗ policy create failed"; exit 1; }
fi
echo "  ✓ policy: $POLICY_ID"

# Trust-but-verify part 1 (security-reviewer 2026-07-02): read the policy BACK and assert
# all 8 resource entries survived with non-empty criteria — the server silently drops
# malformed criteria, which would fail open. Fail here, not in prod.
POLICY_BACK="$(curl -s "$BASE/fhir/R4/AccessPolicy/$POLICY_ID" -H "Authorization: Bearer $ACCESS")"
ENTRY_COUNT="$(printf '%s' "$POLICY_BACK" | jq '[.resource[]? | select((.criteria // "") != "")] | length')"
WANT_COUNT="$(printf '%s' "$POLICY_SRC" | jq '[.resource[]?] | length')"
[ "$ENTRY_COUNT" = "$WANT_COUNT" ] \
  && echo "  ✓ policy read-back: $ENTRY_COUNT/$WANT_COUNT resource entries, all with criteria" \
  || { echo "  ✗ policy read-back has $ENTRY_COUNT criteria-bearing entries (want $WANT_COUNT) — criteria dropped?"; exit 1; }

# Invite a SYNTHETIC patient user so the brokered-login flow is exercisable out of the box.
# Synthetic, non-PHI; LOCAL DEV ONLY. On some existing dev projects the invite 409s with an
# OperationOutcome instead of upserting (user created by an older script version) — in that
# case we locate the existing membership and REPAIR the policy binding ourselves: an unbound
# membership means full project access, the exact state the verify below fails loudly on.
echo "→ inviting synthetic patient 'synthia.login@example.test' (policy-bound)…"
INVITE_RES="$(curl -s -X POST "$BASE/admin/projects/$PID/invite" -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg pid "$POLICY_ID" '{resourceType:"Patient",firstName:"Synthia",lastName:"Loginsmith",email:"synthia.login@example.test",password:"synth-pw-12345",sendEmail:false,membership:{accessPolicy:{reference:("AccessPolicy/"+$pid)}}}')")"
# Only a real ProjectMembership counts — an OperationOutcome's id (e.g. "conflict") must not
# leak into the id variable (that produced the ProjectMembership/conflict lookup bug).
MEMBERSHIP_ID="$(printf '%s' "$INVITE_RES" | jq -r 'select(.resourceType == "ProjectMembership") | .id // empty')"
if [ -z "$MEMBERSHIP_ID" ]; then
  echo "  … invite returned no membership (existing user?) — locating and repairing the binding"
  # EXACTLY-ONE matches only (security-reviewer): binding the wrong membership would leave
  # the real one unbound (= full project access) while the script reports success.
  PATIENT_BUNDLE="$(curl -s "$BASE/fhir/R4/Patient?email=synthia.login@example.test" \
    -H "Authorization: Bearer $ACCESS")"
  [ "$(printf '%s' "$PATIENT_BUNDLE" | jq '[.entry[]?] | length')" = "1" ] \
    || { echo "✗ expected exactly one synthetic patient by email; invite said: $INVITE_RES"; exit 1; }
  PATIENT_ID="$(printf '%s' "$PATIENT_BUNDLE" | jq -r '.entry[0].resource.id')"
  MEMBERSHIP_BUNDLE="$(curl -s "$BASE/fhir/R4/ProjectMembership?profile=Patient/$PATIENT_ID" \
    -H "Authorization: Bearer $ACCESS")"
  [ "$(printf '%s' "$MEMBERSHIP_BUNDLE" | jq '[.entry[]?] | length')" = "1" ] \
    || { echo "✗ expected exactly one membership for Patient/$PATIENT_ID — reset the stack (docker compose down -v) and re-run"; exit 1; }
  MEMBERSHIP_ID="$(printf '%s' "$MEMBERSHIP_BUNDLE" | jq -r '.entry[0].resource.id')"
  # Repair-to-least-privilege: bind the approved patient-self-v1 policy (no policy content
  # change, no widening — the unbound membership is the unsafe state). The PUT round-trips
  # the fetched resource with only accessPolicy replaced, and success requires the response
  # to BE a membership bound to the policy (an OperationOutcome's id must never pass again).
  MEMBERSHIP_RES="$(curl -s "$BASE/fhir/R4/ProjectMembership/$MEMBERSHIP_ID" -H "Authorization: Bearer $ACCESS")"
  printf '%s' "$MEMBERSHIP_RES" | jq -e --arg pid "Patient/$PATIENT_ID" \
    '.resourceType == "ProjectMembership" and .profile.reference == $pid' >/dev/null \
    || { echo "✗ membership $MEMBERSHIP_ID does not belong to Patient/$PATIENT_ID"; exit 1; }
  curl -s -X PUT "$BASE/fhir/R4/ProjectMembership/$MEMBERSHIP_ID" -H "Authorization: Bearer $ACCESS" \
    -H 'Content-Type: application/fhir+json' \
    -d "$(printf '%s' "$MEMBERSHIP_RES" | jq --arg p "AccessPolicy/$POLICY_ID" '.accessPolicy = {reference: $p}')" \
    | jq -e --arg p "AccessPolicy/$POLICY_ID" \
      '.resourceType == "ProjectMembership" and .accessPolicy.reference == $p' >/dev/null \
    || { echo "✗ membership rebind failed"; exit 1; }
  echo "  ✓ rebound existing membership $MEMBERSHIP_ID to patient-self-v1"
fi
echo "  ✓ synthetic patient ready (synthia.login@example.test / synth-pw-12345)"

# Trust-but-verify part 2: THIS user's membership (not just any membership) must reference
# the policy — a policy-less membership has full project access. Also assert no stale
# parameterized access[] survives: Medplum resolves access[] IN PREFERENCE to accessPolicy,
# so a leftover array would silently override the binding (security-reviewer 2026-07-04).
MEMBERSHIP_BACK="$(curl -s "$BASE/fhir/R4/ProjectMembership/$MEMBERSHIP_ID" \
  -H "Authorization: Bearer $ACCESS")"
MEMBERSHIP_POLICY="$(printf '%s' "$MEMBERSHIP_BACK" | jq -r '.accessPolicy.reference // empty')"
[ "$MEMBERSHIP_POLICY" = "AccessPolicy/$POLICY_ID" ] \
  && echo "  ✓ membership $MEMBERSHIP_ID bound to $MEMBERSHIP_POLICY" \
  || { echo "  ✗ membership $MEMBERSHIP_ID is NOT policy-bound (got: '$MEMBERSHIP_POLICY')"; exit 1; }
[ "$(printf '%s' "$MEMBERSHIP_BACK" | jq '(.access // []) | length')" = "0" ] \
  || { echo "  ✗ membership $MEMBERSHIP_ID carries a parameterized access[] that would override the policy"; exit 1; }

############################################################
# S5 — staff foundation: A3 staff policies, staff seed identities, org tagging, A7 bot.
# All synthetic, LOCAL DEV ONLY. Every binding is verified by read-back (fail loud).
############################################################

SEED_SYS="https://medibun.com/fhir/identifiers/demo-seed"

# Upsert an AccessPolicy from policies/<file>; echoes the policy id. Read-back asserts
# entry count AND criteria-bearing count (the server silently drops malformed criteria).
upsert_policy() { # <file>
  local src name pid_existing pid back total want_total crit want_crit
  src="$(cat "$HERE/policies/$1")"
  name="$(printf '%s' "$src" | jq -r '.name')"
  pid_existing="$(curl -s "$BASE/fhir/R4/AccessPolicy?name=$name" \
    -H "Authorization: Bearer $ACCESS" | jq -r '.entry[0].resource.id // empty')"
  if [ -n "$pid_existing" ]; then
    pid="$pid_existing"
    curl -s -X PUT "$BASE/fhir/R4/AccessPolicy/$pid" -H "Authorization: Bearer $ACCESS" \
      -H 'Content-Type: application/fhir+json' \
      -d "$(printf '%s' "$src" | jq --arg id "$pid" '. + {id: $id}')" | jq -e '.id' >/dev/null \
      || { echo "✗ policy update failed: $name" >&2; exit 1; }
  else
    pid="$(curl -s -X POST "$BASE/fhir/R4/AccessPolicy" -H "Authorization: Bearer $ACCESS" \
      -H 'Content-Type: application/fhir+json' -d "$src" | jq -r '.id')"
    [ -n "$pid" ] && [ "$pid" != "null" ] || { echo "✗ policy create failed: $name" >&2; exit 1; }
  fi
  back="$(curl -s "$BASE/fhir/R4/AccessPolicy/$pid" -H "Authorization: Bearer $ACCESS")"
  total="$(printf '%s' "$back" | jq '[.resource[]?] | length')"
  want_total="$(printf '%s' "$src" | jq '[.resource[]?] | length')"
  crit="$(printf '%s' "$back" | jq '[.resource[]? | select((.criteria // "") != "")] | length')"
  want_crit="$(printf '%s' "$src" | jq '[.resource[]? | select((.criteria // "") != "")] | length')"
  { [ "$total" = "$want_total" ] && [ "$crit" = "$want_crit" ]; } \
    || { echo "✗ policy read-back mismatch for $name ($total/$want_total entries, $crit/$want_crit criteria)" >&2; exit 1; }
  echo "$pid"
}

echo "→ upserting staff AccessPolicies (A3)…"
FD_POLICY_ID="$(upsert_policy staff-front-desk.json)"
echo "  ✓ staff-front-desk-v1: $FD_POLICY_ID"
CL_POLICY_ID="$(upsert_policy staff-clinician.json)"
echo "  ✓ staff-clinician-v1: $CL_POLICY_ID"
BOT_POLICY_ID="$(upsert_policy bot-check-in.json)"
echo "  ✓ bot-check-in-v1: $BOT_POLICY_ID"

# Organization anchor (ADR-0003). Conditional create by the demo-seed identifier —
# `pnpm demo:seed` upserts onto the SAME resource later (identifier reconciliation).
echo "→ ensuring Organization (Aureva)…"
ORG_ID="$(curl -s "$BASE/fhir/R4/Organization?identifier=$SEED_SYS%7Corg-aureva" \
  -H "Authorization: Bearer $ACCESS" | jq -r '.entry[0].resource.id // empty')"
if [ -z "$ORG_ID" ]; then
  ORG_ID="$(curl -s -X POST "$BASE/fhir/R4/Organization" -H "Authorization: Bearer $ACCESS" \
    -H 'Content-Type: application/fhir+json' \
    -d "$(jq -n --arg sys "$SEED_SYS" '{resourceType:"Organization",name:"Aureva",active:true,identifier:[{system:$sys,value:"org-aureva"}]}')" \
    | jq -r '.id')"
fi
[ -n "$ORG_ID" ] && [ "$ORG_ID" != "null" ] || { echo "✗ organization ensure failed"; exit 1; }
echo "  ✓ Organization/$ORG_ID"

# Canonical staff Practitioners: conditional create by seed identifier so demo:seed's
# upsert reconciles onto the SAME resource (e.g. adds Riley's timezone extension).
ensure_practitioner() { # <key> <given> <family>
  local id
  id="$(curl -s "$BASE/fhir/R4/Practitioner?identifier=$SEED_SYS%7C$1" \
    -H "Authorization: Bearer $ACCESS" | jq -r '.entry[0].resource.id // empty')"
  if [ -z "$id" ]; then
    id="$(curl -s -X POST "$BASE/fhir/R4/Practitioner" -H "Authorization: Bearer $ACCESS" \
      -H 'Content-Type: application/fhir+json' \
      -d "$(jq -n --arg sys "$SEED_SYS" --arg key "$1" --arg given "$2" --arg family "$3" \
        '{resourceType:"Practitioner",name:[{given:[$given],family:$family}],identifier:[{system:$sys,value:$key}]}')" \
      | jq -r '.id')"
  fi
  [ -n "$id" ] && [ "$id" != "null" ] || { echo "✗ practitioner ensure failed: $1" >&2; exit 1; }
  echo "$id"
}

# PractitionerRole binds practitioner ⇄ org (DATA_MODEL.md). Conditional by identifier.
ensure_role() { # <key> <practitioner_id> <text>
  local existing
  existing="$(curl -s "$BASE/fhir/R4/PractitionerRole?identifier=$SEED_SYS%7C$1" \
    -H "Authorization: Bearer $ACCESS" | jq -r '.entry[0].resource.id // empty')"
  [ -n "$existing" ] && return 0
  curl -s -X POST "$BASE/fhir/R4/PractitionerRole" -H "Authorization: Bearer $ACCESS" \
    -H 'Content-Type: application/fhir+json' \
    -d "$(jq -n --arg sys "$SEED_SYS" --arg key "$1" --arg prac "Practitioner/$2" --arg org "Organization/$ORG_ID" --arg text "$3" \
      '{resourceType:"PractitionerRole",identifier:[{system:$sys,value:$key}],practitioner:{reference:$prac},organization:{reference:$org},code:[{text:$text}]}')" \
    | jq -e '.id' >/dev/null || { echo "✗ practitioner role failed: $1"; exit 1; }
}

# Staff invite → membership repointed to the canonical Practitioner and bound via a
# PARAMETERIZED access[] entry (policy + organization, ADR-0003) — NOT accessPolicy
# (Medplum resolves access[] in preference; one source of truth only). Verified by
# read-back. NO MFA for these synthetic dev identities: the recorded A4 option (b)
# exception (docs/AUTH.md review log 2026-07-02); brokered TOTP is REQUIRED before any
# real staff account exists. The invite's auto-created Practitioner is left unused when
# it differs from the canonical one (no identifier, no schedule — never surfaces).
invite_staff() { # <email> <given> <family> <policy_id> <practitioner_id>
  local email="$1" given="$2" family="$3" policy="$4" prac="$5"
  local invite mid mres back
  invite="$(curl -s -X POST "$BASE/admin/projects/$PID/invite" -H "Authorization: Bearer $ACCESS" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg e "$email" --arg g "$given" --arg f "$family" \
      '{resourceType:"Practitioner",firstName:$g,lastName:$f,email:$e,password:"staff-pw-12345",sendEmail:false}')")"
  mid="$(printf '%s' "$invite" | jq -r 'select(.resourceType == "ProjectMembership") | .id // empty')"
  if [ -z "$mid" ]; then
    # Re-run path: the membership exists and already points at the canonical
    # practitioner. EXACTLY-ONE or fail loud (an unbound membership = full access).
    local bundle
    bundle="$(curl -s "$BASE/fhir/R4/ProjectMembership?profile=Practitioner/$prac" \
      -H "Authorization: Bearer $ACCESS")"
    [ "$(printf '%s' "$bundle" | jq '[.entry[]?] | length')" = "1" ] \
      || { echo "✗ expected exactly one membership for Practitioner/$prac ($email) — reset the stack (docker compose down -v) and re-run"; exit 1; }
    mid="$(printf '%s' "$bundle" | jq -r '.entry[0].resource.id')"
  fi
  mres="$(curl -s "$BASE/fhir/R4/ProjectMembership/$mid" -H "Authorization: Bearer $ACCESS")"
  printf '%s' "$mres" | jq -e '.resourceType == "ProjectMembership"' >/dev/null \
    || { echo "✗ could not fetch membership $mid for $email"; exit 1; }
  curl -s -X PUT "$BASE/fhir/R4/ProjectMembership/$mid" -H "Authorization: Bearer $ACCESS" \
    -H 'Content-Type: application/fhir+json' \
    -d "$(printf '%s' "$mres" | jq --arg prac "Practitioner/$prac" --arg pol "AccessPolicy/$policy" --arg org "Organization/$ORG_ID" \
      'del(.accessPolicy) | .profile = {reference: $prac} | .access = [{policy: {reference: $pol}, parameter: [{name: "organization", valueReference: {reference: $org}}]}]')" \
    >/dev/null
  # Trust-but-verify: profile repointed, ONE parameterized access entry, no accessPolicy.
  back="$(curl -s "$BASE/fhir/R4/ProjectMembership/$mid" -H "Authorization: Bearer $ACCESS")"
  printf '%s' "$back" | jq -e --arg prac "Practitioner/$prac" --arg pol "AccessPolicy/$policy" --arg org "Organization/$ORG_ID" \
    '.profile.reference == $prac
     and ((.access // []) | length) == 1
     and .access[0].policy.reference == $pol
     and .access[0].parameter == [{"name": "organization", "valueReference": {"reference": $org}}]
     and ((.accessPolicy // empty) | not)' >/dev/null \
    || { echo "✗ staff membership binding failed for $email (membership $mid)"; exit 1; }
  echo "  ✓ $email → Practitioner/$prac, org-parameterized policy bound (membership $mid)"
}

echo "→ seeding staff identities (synthetic; NO MFA per the recorded A4-b exception)…"
NOOR_ID="$(ensure_practitioner prac-noor-haddad Noor Haddad)"
ensure_role role-noor-frontdesk "$NOOR_ID" "Front desk"
invite_staff noor.frontdesk@example.test Noor Haddad "$FD_POLICY_ID" "$NOOR_ID"

RILEY_ID="$(ensure_practitioner prac-riley-reyes Riley Reyes)"
ensure_role role-riley-clinician "$RILEY_ID" "Clinician"
invite_staff riley.reyes@example.test Riley Reyes "$CL_POLICY_ID" "$RILEY_ID"

# Org-tag the synthetic patient (meta.accounts, ADR-0003): the staff policies' org
# compartments match through it, and account tags PROPAGATE onto new patient-compartment
# writes (Appointments from $book, Encounters from the bot). Direct meta.accounts writes
# are admin-only — the project OWNER token qualifies. Also ensure a synthetic phone (the
# day sheet's detail popover shows it; 555 numbers are the reserved fictional range).
echo "→ org-tagging the synthetic patient (meta.accounts)…"
SYNTHIA_ID="$(curl -s "$BASE/fhir/R4/Patient?email=synthia.login@example.test" \
  -H "Authorization: Bearer $ACCESS" | jq -r '.entry[0].resource.id // empty')"
[ -n "$SYNTHIA_ID" ] || { echo "✗ synthetic patient not found for org tagging"; exit 1; }
SYNTHIA_RES="$(curl -s "$BASE/fhir/R4/Patient/$SYNTHIA_ID" -H "Authorization: Bearer $ACCESS")"
curl -s -X PUT "$BASE/fhir/R4/Patient/$SYNTHIA_ID" -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/fhir+json' \
  -d "$(printf '%s' "$SYNTHIA_RES" | jq --arg org "Organization/$ORG_ID" \
    '.meta = ((.meta // {}) + {accounts: [{reference: $org}]})
     | .telecom = ((.telecom // []) | if any(.[]; .system == "phone") then . else . + [{system: "phone", value: "555-010-0100"}] end)')" \
  >/dev/null
curl -s "$BASE/fhir/R4/Patient/$SYNTHIA_ID" -H "Authorization: Bearer $ACCESS" \
  | jq -e --arg org "Organization/$ORG_ID" '.meta.accounts // [] | any(.reference == $org)' >/dev/null \
  && echo "  ✓ Patient/$SYNTHIA_ID tagged with Organization/$ORG_ID" \
  || { echo "  ✗ meta.accounts tag did not persist (admin-only write — check the token)"; exit 1; }

# Check-in Bot (A7): reuse by name (no duplicate bots/subscriptions on re-runs), create
# WITH membership when absent, bind the narrow bot policy (plain accessPolicy — the bot
# is a system principal, not org-scoped). Code deploy + Subscription happen after .env
# is written, via the reviewed deploy script (never the in-app editor).
echo "→ ensuring check-in Bot (A7)…"
CHECKIN_BID="$(curl -s "$BASE/fhir/R4/Bot?name=check-in-bot" \
  -H "Authorization: Bearer $ACCESS" | jq -r '.entry[0].resource.id // empty')"
if [ -z "$CHECKIN_BID" ]; then
  CHECKIN_BID="$(curl -s -X POST "$BASE/admin/projects/$PID/bot" -H "Authorization: Bearer $ACCESS" \
    -H 'Content-Type: application/json' \
    -d '{"name":"check-in-bot","description":"S5 check-in: Appointment status drives the Encounter (A7)","runtimeVersion":"vmcontext"}' \
    | jq -r '.id')"
fi
[ -n "$CHECKIN_BID" ] && [ "$CHECKIN_BID" != "null" ] || { echo "✗ check-in bot create failed"; exit 1; }
BOT_MEMBERSHIP="$(curl -s "$BASE/fhir/R4/ProjectMembership?profile=Bot/$CHECKIN_BID" \
  -H "Authorization: Bearer $ACCESS" | jq -r '.entry[0].resource.id // empty')"
[ -n "$BOT_MEMBERSHIP" ] || { echo "✗ check-in bot has no membership"; exit 1; }
BOT_MRES="$(curl -s "$BASE/fhir/R4/ProjectMembership/$BOT_MEMBERSHIP" -H "Authorization: Bearer $ACCESS")"
curl -s -X PUT "$BASE/fhir/R4/ProjectMembership/$BOT_MEMBERSHIP" -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/fhir+json' \
  -d "$(printf '%s' "$BOT_MRES" | jq --arg pol "AccessPolicy/$BOT_POLICY_ID" \
    '.accessPolicy = {reference: $pol} | del(.access)')" \
  | jq -e --arg pol "AccessPolicy/$BOT_POLICY_ID" '.accessPolicy.reference == $pol' >/dev/null \
  || { echo "✗ bot membership policy binding failed"; exit 1; }
echo "  ✓ check-in bot: $CHECKIN_BID (membership $BOT_MEMBERSHIP → bot-check-in-v1)"

cat > "$HERE/.env" <<EOF
MEDPLUM_BASE_URL=$BASE/
MEDPLUM_CLIENT_ID=$CID
MEDPLUM_CLIENT_SECRET=$CSECRET
MEDPLUM_BOT_ID=$BID
MEDPLUM_CHECKIN_BOT_ID=$CHECKIN_BID
MEDPLUM_PROJECT_ID=$PID

# Experience DB + auth (apps/api). Synthetic local dev only — see .env.example.
EXPERIENCE_DATABASE_URL=postgres://medibun:medibun@localhost:5433/medibun_experience
SESSION_ENCRYPTION_KEY=$(openssl rand -base64 32)
API_COOKIE_INSECURE_DEV=1
API_ALLOWED_ORIGINS=http://localhost:3100,http://localhost:3200,http://127.0.0.1:3100,http://127.0.0.1:3200
EOF
echo "✓ wrote $HERE/.env (gitignored). Client: $CID  Bot: $BID  Project: $PID"

echo "→ migrating experience db…"
(cd "$HERE/../.." && pnpm --filter @medibun/api db:migrate) \
  && echo "  ✓ experience db migrated" \
  || { echo "✗ experience db migration failed"; exit 1; }

echo "→ deploying check-in bot code + subscription (A7)…"
(cd "$HERE/../.." && pnpm --filter @medibun/medplum-backend deploy:bot:check-in) \
  && echo "  ✓ check-in bot deployed + subscribed" \
  || { echo "✗ check-in bot deploy failed"; exit 1; }
