Copy files between DA (Document Authoring) orgs/repos, skipping files that already exist in the destination.

## Arguments

$ARGUMENTS — Required: `<source> <destination> [path]`. Source and destination are `org/repo` (e.g., `paolomoz/arco carlossg/arco`). Path is an optional subdirectory to copy (e.g., `products`, `blog/travel`). If path is omitted, copies everything.

## Instructions

Use the script at `tools/da-copy.sh` to copy missing DA files between orgs.

### Configuration

- **DA token**: preferred source is the AEM CLI login token at `.hlx/.da-token.json` (`.access_token`, auto-refreshed by `aem up`); falls back to gcloud secret `DA_TOKEN` then `.env` `DA_TOKEN`/`DA_BEARER_TOKEN`
- **Script**: `./tools/da-copy.sh`

### Steps

1. **Parse arguments** to extract source org/repo, destination org/repo, and optional path.

2. **If no path specified**, run the script without a path first to list top-level directories, then run it for each directory:
   ```bash
   ./tools/da-copy.sh <src> <dst>           # lists directories
   ./tools/da-copy.sh <src> <dst> products   # copies products/
   ./tools/da-copy.sh <src> <dst> blog       # copies blog/
   # ... etc for each directory
   ```

3. **If a path is specified**, run:
   ```bash
   ./tools/da-copy.sh <src> <dst> <path>
   ```

4. **Report results**: total files copied, skipped, and already existing.

### Important notes

- The script recursively discovers all .html files under the given path and only copies files missing in the destination
- Files that already exist in the destination are NOT overwritten
- The DA token expires after 24 hours — if you get 401s, tell the user to refresh their token at da.live
- For large directories (100+ files), the script may take several minutes
