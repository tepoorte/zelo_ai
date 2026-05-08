#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMMIT_MESSAGE="${1:-Prepare production Zelo AI deploy}"

echo "== Zelo AI commit + push =="
echo "Root: $ROOT_DIR"
echo "Commit message: $COMMIT_MESSAGE"
echo ""

echo "== Remove tracked .DS_Store from Git index only =="
TRACKED_DS_STORE="$(git ls-files | grep -E '(^|/)\.DS_Store$' || true)"
if [ -n "$TRACKED_DS_STORE" ]; then
  echo "$TRACKED_DS_STORE" | while IFS= read -r file; do
    git rm --cached --ignore-unmatch "$file"
  done
else
  echo "No tracked .DS_Store files."
fi
echo ""

echo "== Stage everything allowed by .gitignore =="
git add .
echo ""

echo "== Staged diff summary =="
git diff --cached --stat
echo ""

echo "== Staged files =="
git diff --cached --name-status
echo ""

read -r -p "Commit and push these staged changes to origin/main? Type YES: " CONFIRM
if [ "$CONFIRM" != "YES" ]; then
  echo "Aborted before commit."
  exit 1
fi

git commit -m "$COMMIT_MESSAGE"
git push origin main

echo ""
echo "Commit pushed."
