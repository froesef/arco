#!/opt/homebrew/bin/bash
# Upload draft HTML files and media to DA (Document Authoring)
# Usage: ./tools/upload-to-da.sh [specific-file]
#        ./tools/upload-to-da.sh --media          # upload media files only
#        ./tools/upload-to-da.sh --all            # upload HTML + media
# If no file specified, uploads all .plain.html files in drafts/

set -euo pipefail

DRY_RUN=false
UPLOAD_MEDIA=false
UPLOAD_HTML=true
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true; shift ;;
    --media) UPLOAD_MEDIA=true; UPLOAD_HTML=false; shift ;;
    --all) UPLOAD_MEDIA=true; UPLOAD_HTML=true; shift ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DRAFTS_DIR="$PROJECT_DIR/drafts"
FRAGMENTS_DIR="$PROJECT_DIR/fragments"
MODALS_DIR="$PROJECT_DIR/modals"

# Read env vars from .env file (|| true to avoid set -e failures on missing keys)
DA_CLIENT_ID=$(grep "DA_CLIENT_ID" "$PROJECT_DIR/.env" 2>/dev/null | sed 's/DA_CLIENT_ID=//' | tr -d '"' || true)
DA_CLIENT_SECRET=$(grep "DA_CLIENT_SECRET" "$PROJECT_DIR/.env" 2>/dev/null | sed 's/DA_CLIENT_SECRET=//' | tr -d '"' || true)
DA_SERVICE_TOKEN=$(grep "DA_SERVICE_TOKEN" "$PROJECT_DIR/.env" 2>/dev/null | sed 's/DA_SERVICE_TOKEN=//' | tr -d '"' || true)
DA_ORG=$(grep "DA_ORG" "$PROJECT_DIR/.env" 2>/dev/null | sed 's/DA_ORG=//' | tr -d '"' || true)
DA_REPO=$(grep "DA_REPO" "$PROJECT_DIR/.env" 2>/dev/null | sed 's/DA_REPO=//' | tr -d '"' || true)

DA_ORG="${DA_ORG:?DA_ORG must be set in .env}"
DA_REPO="${DA_REPO:?DA_REPO must be set in .env}"
DA_API="https://admin.da.live/source/$DA_ORG/$DA_REPO"

ACCESS_TOKEN=""
if [ "$DRY_RUN" = false ]; then
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
fi

upload_file() {
  local plain_file
  plain_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
  local progress="${2:-}"
  local prefix=""
  [ -n "$progress" ] && prefix="[$progress] "
  local rel_path=""
  if [[ "$plain_file" == "$DRAFTS_DIR/"* ]]; then
    rel_path="${plain_file#$DRAFTS_DIR/}"
  elif [[ "$plain_file" == "$FRAGMENTS_DIR/"* ]]; then
    rel_path="${plain_file#$PROJECT_DIR/}"
  elif [[ "$plain_file" == "$MODALS_DIR/"* ]]; then
    rel_path="${plain_file#$PROJECT_DIR/}"
  else
    echo "${prefix}SKIP: $plain_file (unsupported HTML root)"
    return 1
  fi
  local da_path="${rel_path%.plain.html}.html"

  # Convert plain HTML to DA format
  local tmp_file
  tmp_file=$(mktemp)
  mv "$tmp_file" "$tmp_file.html"
  tmp_file="$tmp_file.html"
  python3 "$SCRIPT_DIR/plain-to-da.py" "$plain_file" > "$tmp_file" 2>/dev/null

  if [ ! -s "$tmp_file" ]; then
    echo "${prefix}SKIP: $rel_path (empty conversion)"
    rm -f "$tmp_file"
    return 1
  fi

  if [ "$DRY_RUN" = true ]; then
    echo "${prefix} DRY: $da_path ($(wc -c < "$tmp_file" | tr -d ' ') bytes)"
    rm -f "$tmp_file"
    return 0
  fi

  local url="$DA_API/$da_path"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -F "data=@$tmp_file;type=text/html" \
    "$url")

  rm -f "$tmp_file"

  if [ "$status" = "200" ] || [ "$status" = "201" ] || [ "$status" = "204" ]; then
    echo "${prefix}  OK: $da_path ($status)"
    return 0
  else
    echo "${prefix}FAIL: $da_path (HTTP $status)"
    return 1
  fi
}

upload_media() {
  local media_file
  media_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
  local progress="${2:-}"
  local rel_path="${media_file#$DRAFTS_DIR/}"
  local da_path="$rel_path"
  local prefix=""
  [ -n "$progress" ] && prefix="[$progress] "

  # Determine content type
  local content_type
  case "${media_file##*.}" in
    jpg|jpeg) content_type="image/jpeg" ;;
    png)      content_type="image/png" ;;
    gif)      content_type="image/gif" ;;
    webp)     content_type="image/webp" ;;
    svg)      content_type="image/svg+xml" ;;
    mp4)      content_type="video/mp4" ;;
    pdf)      content_type="application/pdf" ;;
    *)        content_type="application/octet-stream" ;;
  esac

  if [ "$DRY_RUN" = true ]; then
    local size
    size=$(wc -c < "$media_file" | tr -d ' ')
    echo "${prefix} DRY: $da_path ($size bytes, $content_type)"
    return 0
  fi

  local url="$DA_API/$da_path"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PUT \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -F "data=@${media_file};type=${content_type}" \
    "$url")

  if [ "$status" = "200" ] || [ "$status" = "201" ] || [ "$status" = "204" ]; then
    echo "${prefix}  OK: $da_path ($status)"
    return 0
  else
    echo "${prefix}FAIL: $da_path (HTTP $status)"
    return 1
  fi
}

# ── Run uploads ──────────────────────────────────────────────────────────────

MAX_PARALLEL="${MAX_PARALLEL:-10}"

if [ "$DRY_RUN" = true ]; then
  echo "DRY RUN — no uploads will be made"
fi
echo "Uploading to DA: $DA_API"
echo "Parallel workers: $MAX_PARALLEL"
echo "---"

run_parallel() {
  local label="$1"
  shift
  local files=("$@")
  local total=${#files[@]}
  local results_dir
  results_dir=$(mktemp -d)
  local count=0
  local running=0

  echo ""
  echo "=== $label ($total files) ==="

  for file in "${files[@]}"; do
    count=$((count+1))
    (
      if "$UPLOAD_FN" "$file" "$count/$total"; then
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

  local success fail
  success=$(find "$results_dir" -name "ok-*" | wc -l | tr -d ' ')
  fail=$(find "$results_dir" -name "fail-*" | wc -l | tr -d ' ')
  rm -rf "$results_dir"

  echo "--- $label done: $success uploaded, $fail failed out of $total"
}

if [ -n "${1:-}" ] && [[ "$1" != --* ]]; then
  # Upload single file
  if [[ "$1" == *.plain.html ]]; then
    upload_file "$1" && echo "--- Done: 1 uploaded" || echo "--- Done: 0 uploaded, 1 failed"
  else
    upload_media "$1" && echo "--- Done: 1 uploaded" || echo "--- Done: 0 uploaded, 1 failed"
  fi
else
  # Upload HTML pages
  if [ "$UPLOAD_HTML" = true ]; then
    mapfile -t html_files < <(
      {
        find "$DRAFTS_DIR" -name "*.plain.html" 2>/dev/null
        find "$FRAGMENTS_DIR" -name "*.plain.html" 2>/dev/null
        find "$MODALS_DIR" -name "*.plain.html" 2>/dev/null
      } | sort
    )
    UPLOAD_FN=upload_file
    run_parallel "HTML pages" "${html_files[@]}"
  fi

  # Upload media files
  if [ "$UPLOAD_MEDIA" = true ]; then
    mapfile -t media_files < <(find "$DRAFTS_DIR/media" -type f \( -name "*.jpeg" -o -name "*.jpg" -o -name "*.png" -o -name "*.gif" -o -name "*.webp" -o -name "*.svg" \) 2>/dev/null | sort)
    UPLOAD_FN=upload_media
    run_parallel "Media files" "${media_files[@]}"
  fi
fi
