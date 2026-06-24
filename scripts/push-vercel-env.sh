#!/usr/bin/env bash
# Upload .env.production to Vercel (Production environment).
# Secrets are marked --sensitive (encrypted, hidden in dashboard/CLI).
#
# Usage:
#   1. Fill in real values in .env.production (gitignored)
#   2. vercel link   (if not already linked)
#   3. ./scripts/push-vercel-env.sh
#
# Options:
#   ENV_FILE=.env.production  — source file (default)
#   VERCEL_ENV=production     — production | preview | development
#   DRY_RUN=1                 — print commands only, do not upload

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.production}"
VERCEL_ENV="${VERCEL_ENV:-production}"
DRY_RUN="${DRY_RUN:-0}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

if ! command -v vercel >/dev/null 2>&1; then
  echo "Install Vercel CLI: npm i -g vercel" >&2
  exit 1
fi

# Keys that must be uploaded as sensitive (encrypted on Vercel).
SENSITIVE_KEYS=(
  OPENAI_API_KEY
  CLERK_SECRET_KEY
  CLERK_PUBLISHABLE
  MONGODB_URI
  META_APP_SECRET
  GOOGLE_MAPS_API_KEY
  STRIPE_SECRET_KEY
  STRIPE_PUBLISHABLE_KEY
  STRIPE_WEBHOOK_SECRET
  STRIPE_CONNECT_CLIENT_ID
  STRIPE_CONNECT_STATE_SECRET
  SMTP_PASS
  SMTP_USER
  SESSION_TOKEN_SECRET
  MEDIA_SIGN_SECRET
  ABLY_API_KEY
  REDIS_PASSWORD
  SENTRY_DSN
  META_PHONE_REGISTER_PIN
)

# Skip comments, blanks, and Vercel-managed vars.
SKIP_PREFIXES=(VERCEL_ GIT_)

is_sensitive() {
  local key="$1"
  for s in "${SENSITIVE_KEYS[@]}"; do
    [[ "$key" == "$s" ]] && return 0
  done
  # Heuristic: anything with SECRET, PASS, KEY, TOKEN, URI in the name
  [[ "$key" =~ (SECRET|PASSWORD|_PASS$|_KEY$|_TOKEN$|_URI$|_DSN$) ]] && return 0
  return 1
}

should_skip() {
  local key="$1"
  local val="$2"
  [[ -z "$val" ]] && return 0
  [[ "$key" =~ ^# ]] && return 0
  for p in "${SKIP_PREFIXES[@]}"; do
    [[ "$key" == "$p"* ]] && return 0
  done
  return 1
}

upload_var() {
  local key="$1"
  local val="$2"
  local extra=()
  if is_sensitive "$key"; then
    extra+=(--sensitive)
  fi
  extra+=(--force)

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] $key -> $VERCEL_ENV ${extra[*]}"
    return 0
  fi

  printf '%s' "$val" | vercel env add "$key" "$VERCEL_ENV" "${extra[@]}"
  echo "  ✓ $key"
}

echo "Uploading from $ENV_FILE to Vercel ($VERCEL_ENV)..."
echo ""

count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" || "$line" == \#* ]] && continue

  if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    # Strip surrounding quotes
    val="${val%\"}"
    val="${val#\"}"
    val="${val%\'}"
    val="${val#\'}"

    if should_skip "$key" "$val"; then
      echo "  - skip $key (empty or managed)"
      continue
    fi

    upload_var "$key" "$val"
    count=$((count + 1))
  fi
done < "$ENV_FILE"

echo ""
echo "Done. Uploaded $count variable(s) to $VERCEL_ENV."
echo "Redeploy for changes to take effect: vercel --prod"
