#!/opt/homebrew/bin/bash
# Preview all uploaded pages on AEM Edge Delivery
# Triggers the preview CDN to pick up content from DA
# Usage: ./tools/preview-all.sh [path-prefix]
#        ./tools/preview-all.sh hero-gallery    # preview single page
#        ./tools/preview-all.sh blog/           # preview all blog pages

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DRAFTS_DIR="$PROJECT_DIR/drafts"
FRAGMENTS_DIR="$PROJECT_DIR/fragments"
MODALS_DIR="$PROJECT_DIR/modals"

# Read env vars from .env file (|| true to avoid set -e failures on missing keys)
DA_CLIENT_ID=$(grep "DA_CLIENT_ID" "$PROJECT_DIR/.env" 2>/dev/null | sed 's/DA_CLIENT_ID=//' | tr -d '"' || true)
DA_CLIENT_SECRET=$(grep "DA_CLIENT_SECRET" "$PROJECT_DIR/.env" 2>/dev/null | sed 's/DA_CLIENT_SECRET=//' | tr -d '"' || true)
DA_SERVICE_TOKEN=$(grep "DA_SERVICE_TOKEN" "$PROJECT_DIR/.env" 2>/dev/null | sed 's/DA_SERVICE_TOKEN=//' | tr -d '"' || true)
DA_ORG=$(grep "^DA_ORG" "$PROJECT_DIR/.env" 2>/dev/null | sed 's/DA_ORG=//' | tr -d '"' || true)
DA_REPO=$(grep "^DA_REPO" "$PROJECT_DIR/.env" 2>/dev/null | sed 's/DA_REPO=//' | tr -d '"' || true)

DA_ORG="${DA_ORG:?DA_ORG must be set in .env}"
DA_REPO="${DA_REPO:?DA_REPO must be set in .env}"
BRANCH="${BRANCH:-$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
BRANCH_SLUG="${BRANCH//\//-}"
ADMIN_API="https://admin.hlx.page/preview/$DA_ORG/$DA_REPO/$BRANCH_SLUG"
echo "Previewing branch: $BRANCH (as $BRANCH_SLUG)"

# 0. Prefer the AEM CLI's DA login token (auto-refreshed by `aem up`).
DA_TOKEN_FILE="$PROJECT_DIR/.hlx/.da-token.json"
if [ -z "${DA_BEARER_TOKEN:-}" ] && [ -f "$DA_TOKEN_FILE" ]; then
  DA_BEARER_TOKEN=$(python3 -c "import json; print(json.load(open('$DA_TOKEN_FILE')).get('access_token',''))" 2>/dev/null || true)
fi

# 1. DA_BEARER_TOKEN takes precedence (env var or .env, JWT starting with ey...)
DA_BEARER_TOKEN="${DA_BEARER_TOKEN:-$(grep "DA_BEARER_TOKEN" "$PROJECT_DIR/.env" 2>/dev/null | sed 's/DA_BEARER_TOKEN=//' | tr -d '"' || true)}"

if [ -n "$DA_BEARER_TOKEN" ] && [[ "$DA_BEARER_TOKEN" == ey* ]]; then
  echo "Using DA_BEARER_TOKEN directly."
  ACCESS_TOKEN="$DA_BEARER_TOKEN"
elif [ -n "$DA_CLIENT_ID" ] && [ -n "$DA_CLIENT_SECRET" ] && [ -n "$DA_SERVICE_TOKEN" ]; then
  # 2. Fall back to IMS client credentials flow
  echo "Authenticating with Adobe IMS..."
  ACCESS_TOKEN=$(curl -s -X POST "https://ims-na1.adobelogin.com/ims/token/v3" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=authorization_code&client_id=$DA_CLIENT_ID&client_secret=$DA_CLIENT_SECRET&code=$DA_SERVICE_TOKEN" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
fi

if [ -z "$ACCESS_TOKEN" ]; then
  echo "ERROR: Failed to obtain access token"
  echo "Set DA_BEARER_TOKEN (a JWT starting with ey...) or configure DA_CLIENT_ID/DA_CLIENT_SECRET/DA_SERVICE_TOKEN in .env"
  exit 1
fi
echo "Authenticated."
echo ""

MAX_PARALLEL="${MAX_PARALLEL:-10}"

preview_page() {
  local file="$1"
  local progress="$2"
  local rel_path=""
  if [[ "$file" == "$DRAFTS_DIR/"* ]]; then
    rel_path="${file#$DRAFTS_DIR/}"
  elif [[ "$file" == "$FRAGMENTS_DIR/"* ]]; then
    rel_path="${file#$PROJECT_DIR/}"
  elif [[ "$file" == "$MODALS_DIR/"* ]]; then
    rel_path="${file#$PROJECT_DIR/}"
  else
    echo "[$progress] SKIP: $file (unsupported HTML root)"
    return 1
  fi
  local page_path="${rel_path%.plain.html}"

  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    "$ADMIN_API/$page_path")

  if [ "$status" = "200" ] || [ "$status" = "201" ] || [ "$status" = "204" ]; then
    echo "[$progress]   OK: /$page_path ($status)"
    return 0
  else
    echo "[$progress] FAIL: /$page_path (HTTP $status)"
    return 1
  fi
}

# Collect files — optionally filtered by prefix argument
PREFIX="${1:-}"
if [ -n "$PREFIX" ]; then
  mapfile -t files < <(
    {
      find "$DRAFTS_DIR" -name "*.plain.html" -path "*${PREFIX}*" 2>/dev/null
      find "$FRAGMENTS_DIR" -name "*.plain.html" -path "*${PREFIX}*" 2>/dev/null
      find "$MODALS_DIR" -name "*.plain.html" -path "*${PREFIX}*" 2>/dev/null
    } | sort
  )
else
  mapfile -t files < <(
    {
      find "$DRAFTS_DIR" -name "*.plain.html" 2>/dev/null
      find "$FRAGMENTS_DIR" -name "*.plain.html" 2>/dev/null
      find "$MODALS_DIR" -name "*.plain.html" 2>/dev/null
    } | sort
  )
fi

TOTAL=${#files[@]}
if [ "$TOTAL" -eq 0 ]; then
  echo "No pages found to preview."
  exit 0
fi

echo "Previewing $TOTAL pages (parallel workers: $MAX_PARALLEL)..."
echo "---"

results_dir=$(mktemp -d)
count=0
running=0

for file in "${files[@]}"; do
  count=$((count+1))
  (
    if preview_page "$file" "$count/$TOTAL"; then
      touch "$results_dir/ok-$count"
    else
      touch "$results_dir/fail-$count"
    fi
  ) &
  running=$((running+1))

  if [ "$running" -ge "$MAX_PARALLEL" ]; then
    wait -n 2>/dev/null || true
    running=$((running-1))
  fi
done

wait

success=$(find "$results_dir" -name "ok-*" | wc -l | tr -d ' ')
fail=$(find "$results_dir" -name "fail-*" | wc -l | tr -d ' ')
rm -rf "$results_dir"

echo "---"
echo "Done: $success previewed, $fail failed out of $TOTAL"
