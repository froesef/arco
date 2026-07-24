#!/opt/homebrew/bin/bash
# Copy files between DA (Document Authoring) orgs/repos.
#
# Usage:
#   ./tools/da-copy.sh <src> <dst> [path] [--force]
#
# Arguments:
#   src     Source org/repo (e.g. paolomoz/arco)
#   dst     Destination org/repo (e.g. froesef/arco)
#   path    Optional path prefix to copy (e.g. products). Copies everything under it.
#           If omitted, lists top-level directories for you to choose.
#   --force Re-copy files that already exist in destination (fixes content-type issues)
#
# Examples:
#   ./tools/da-copy.sh paolomoz/arco froesef/arco products/comparison
#   ./tools/da-copy.sh paolomoz/arco froesef/arco blog
#   ./tools/da-copy.sh paolomoz/arco froesef/arco media --force
#   ./tools/da-copy.sh paolomoz/arco froesef/arco          # interactive
#
# Requires:
#   - gcloud CLI with access to DA_TOKEN secret, OR
#   - DA_TOKEN environment variable set directly
#
# The script recursively discovers all .html files under the given path
# in the source org and copies any that are missing in the destination.

set -uo pipefail

FORCE=false

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Auth ──────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$(cd "$SCRIPT_DIR/.." && pwd)/.env"

# Prefer the AEM CLI's DA login token (auto-refreshed by `aem up`).
DA_TOKEN_FILE="$(cd "$SCRIPT_DIR/.." && pwd)/.hlx/.da-token.json"
if [ -z "${DA_TOKEN:-}" ] && [ -f "$DA_TOKEN_FILE" ]; then
  DA_TOKEN=$(python3 -c "import json,sys; print(json.load(open('$DA_TOKEN_FILE')).get('access_token',''))" 2>/dev/null || true)
fi

if [ -z "${DA_TOKEN:-}" ]; then
  DA_TOKEN=$(gcloud secrets versions access latest --secret=DA_TOKEN 2>/dev/null || true)
fi

# Fall back to DA_BEARER_TOKEN from env var or .env file
if [ -z "${DA_TOKEN:-}" ]; then
  DA_TOKEN="${DA_BEARER_TOKEN:-$(grep "^DA_BEARER_TOKEN=" "$ENV_FILE" 2>/dev/null | sed 's/DA_BEARER_TOKEN=//' | tr -d '"' || true)}"
fi

if [ -z "$DA_TOKEN" ]; then
  echo -e "${RED}DA_TOKEN not set and could not be retrieved from gcloud secrets.${RESET}"
  echo "Set DA_TOKEN or DA_BEARER_TOKEN in .env, or configure gcloud secrets."
  exit 1
fi

# ── Args ──────────────────────────────────────────────────────────────────────

SRC="${1:-}"
DST="${2:-}"
PREFIX="${3:-}"
if [ "${4:-}" = "--force" ] || [ "${3:-}" = "--force" ]; then FORCE=true; fi

if [ -z "$SRC" ] || [ -z "$DST" ]; then
  echo "Usage: $0 <src-org/repo> <dst-org/repo> [path]"
  echo ""
  echo "Examples:"
  echo "  $0 paolomoz/arco carlossg/arco products"
  echo "  $0 paolomoz/arco carlossg/arco blog/travel"
  exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

# List files and directories at a DA path.
# Outputs lines like "name.html" (file) or "name/" (directory)
da_list() {
  local org_repo="$1" path="$2"
  /usr/bin/curl -s -H "Authorization: Bearer $DA_TOKEN" \
    "https://admin.da.live/list/${org_repo}${path}" | \
    python3 -c "
import sys, json
try:
  data = json.load(sys.stdin)
  for i in data:
    if 'ext' in i:
      print(i['name'] + '.' + i['ext'])
    else:
      print(i['name'] + '/')
except:
  pass
" 2>/dev/null
}

# Recursively list all .html files under a path
da_list_recursive() {
  local org_repo="$1" path="$2"
  local items
  items=$(da_list "$org_repo" "$path")

  while IFS= read -r item; do
    [ -z "$item" ] && continue
    if [[ "$item" == */ ]]; then
      # Directory — recurse
      da_list_recursive "$org_repo" "${path}/${item%/}"
    else
      # File
      echo "${path}/${item}"
    fi
  done <<< "$items"
}

# Detect MIME type from file extension
mime_type() {
  case "${1##*.}" in
    jpg|jpeg) echo "image/jpeg" ;;
    png)      echo "image/png" ;;
    gif)      echo "image/gif" ;;
    webp)     echo "image/webp" ;;
    svg)      echo "image/svg+xml" ;;
    mp4)      echo "video/mp4" ;;
    pdf)      echo "application/pdf" ;;
    html)     echo "text/html" ;;
    *)        echo "application/octet-stream" ;;
  esac
}

# Copy a single file from src to dst
copy_file() {
  local rel_path="$1"
  local tmp=$(/usr/bin/mktemp)

  local http_code=$(/usr/bin/curl -s -o "$tmp" -w "%{http_code}" \
    -H "Authorization: Bearer $DA_TOKEN" \
    "https://admin.da.live/source/${SRC}${rel_path}")

  if [ "$http_code" != "200" ]; then
    echo -e "  ${RED}SKIP${RESET} ${rel_path} (download: ${http_code})"
    /bin/rm -f "$tmp"
    return 1
  fi

  local content_type
  content_type=$(mime_type "$rel_path")

  local put_code=$(/usr/bin/curl -s -o /dev/null -w "%{http_code}" \
    -X PUT \
    -H "Authorization: Bearer $DA_TOKEN" \
    -F "data=@${tmp};type=${content_type}" \
    "https://admin.da.live/source/${DST}${rel_path}")

  if [ "$put_code" = "200" ] || [ "$put_code" = "201" ]; then
    echo -e "  ${GREEN}COPY${RESET} ${rel_path}"
  else
    echo -e "  ${RED}FAIL${RESET} ${rel_path} (upload: ${put_code})"
  fi

  /bin/rm -f "$tmp"
}

# ── Main ──────────────────────────────────────────────────────────────────────

if [ -z "$PREFIX" ]; then
  echo -e "${BOLD}Top-level directories in ${SRC}:${RESET}"
  da_list "$SRC" ""
  echo ""
  echo "Re-run with a path argument to copy files, e.g.:"
  echo "  $0 $SRC $DST products"
  exit 0
fi

echo -e "${BOLD}Discovering files in ${SRC}/${PREFIX}...${RESET}"

# Get all source files
src_files=$(da_list_recursive "$SRC" "/${PREFIX}")
src_count=$(echo "$src_files" | grep -c '.' || true)

if [ "$src_count" -eq 0 ]; then
  echo -e "${YELLOW}No files found in ${SRC}/${PREFIX}${RESET}"
  exit 0
fi

echo -e "${DIM}Found ${src_count} files in source${RESET}"

# Get all destination files for comparison
echo -e "${DIM}Checking destination...${RESET}"
dst_files=$(da_list_recursive "$DST" "/${PREFIX}" 2>/dev/null || true)

# Find files to copy (missing, or all if --force)
missing=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if [ "$FORCE" = true ] || ! echo "$dst_files" | grep -qF "$f"; then
    missing+=("$f")
  fi
done <<< "$src_files"

if [ ${#missing[@]} -eq 0 ]; then
  echo -e "${GREEN}All ${src_count} files already exist in ${DST}/${PREFIX}${RESET}"
  exit 0
fi

echo -e "${BOLD}Copying ${#missing[@]} missing files (${src_count} total in source)...${RESET}"
echo ""

copied=0
failed=0
for f in "${missing[@]}"; do
  if copy_file "$f"; then
    ((copied++))
  else
    ((failed++))
  fi
done

echo ""
echo -e "${BOLD}Done:${RESET} ${GREEN}${copied} copied${RESET}, ${RED}${failed} skipped${RESET}, ${DIM}$((src_count - ${#missing[@]})) already existed${RESET}"
