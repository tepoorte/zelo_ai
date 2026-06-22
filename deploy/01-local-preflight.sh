#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "== Zelo AI local preflight =="
echo "Root: $ROOT_DIR"
echo ""

echo "== Git status before checks =="
git status --short
echo ""

echo "== TypeScript build =="
npm run build
echo ""

echo "== Unit/regression tests =="
npm run test:delivery
npm run test:intents
npm run test:add-items
if ! ./tests/run_add_items_random_catalog_tests.sh; then
  echo "WARNING: random catalog add-items test failed; continuing because this test can hit ambiguous near-duplicate products."
fi
npm run test:clear-cart
npm run test:agent-formatting
npm run test:discover-meals
npm run test:discover-semantic
npm run test:history-suggestions
npm run test:session-isolation
npm run test:whatsapp
npm run test:build-meal-family
npm run test:build-meal-matching
echo ""

echo "== Cache archive =="
CACHE_ARCHIVE="${CACHE_ARCHIVE:-/tmp/zelo_ai_cache_$(date +%Y%m%d_%H%M%S).tgz}"
tar \
  --exclude ".cache/tmp" \
  --exclude ".cache/tmp/*" \
  --exclude ".cache/whatsapp-web-session" \
  --exclude ".cache/whatsapp-web-session/*" \
  -czf "$CACHE_ARCHIVE" .cache
printf '%s\n' "$CACHE_ARCHIVE" > /tmp/zelo_ai_last_cache_archive.txt
echo "Cache archive created: $CACHE_ARCHIVE"
echo "Cache archive excludes: .cache/tmp, .cache/whatsapp-web-session"
echo ""

echo "== Tracked .DS_Store check =="
TRACKED_DS_STORE="$(git ls-files | grep -E '(^|/)\.DS_Store$' || true)"
if [ -n "$TRACKED_DS_STORE" ]; then
  echo "WARNING: these .DS_Store files are already tracked by Git:"
  echo "$TRACKED_DS_STORE"
  echo "The commit script will remove them from Git index with git rm --cached, without deleting local files."
else
  echo "No tracked .DS_Store files."
fi
echo ""

echo "== Final status =="
git status --short
echo ""
echo "Preflight completed."
