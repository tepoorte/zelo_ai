#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ensure_supported_node() {
  local required_version="18.20.8"
  local current_version=""

  current_version="$(node --version 2>/dev/null || true)"
  if [[ "$current_version" =~ ^v(18|20|22)\. ]]; then
    echo "Node runtime: $current_version"
    return
  fi

  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck source=/dev/null
    source "$HOME/.nvm/nvm.sh"
    nvm use "$required_version" >/dev/null
    current_version="$(node --version 2>/dev/null || true)"
  fi

  if [[ ! "$current_version" =~ ^v(18|20|22)\. ]]; then
    echo "ERROR: Node.js 18, 20 or 22 is required for the local preflight."
    echo "Install/use Node $required_version with NVM, then run this script again."
    exit 1
  fi
  echo "Node runtime: $current_version (selected through NVM)"
}

ensure_supported_node

echo "== Zelo AI local preflight =="
echo "Root: $ROOT_DIR"
echo ""

echo "== Git status before checks =="
git status --short
echo ""

echo "== TypeScript build =="
npm run build
echo ""

echo "== Static UI/deploy checks =="
node --check public/inscription-whatsapp.js
bash -n \
  deploy/01-local-preflight.sh \
  deploy/02-commit-and-push.sh \
  deploy/03-build-push-and-server-deploy.sh
echo ""

echo "== Unit/regression tests =="
npm run test:delivery
npm run test:intents
npm run test:add-items
ZELO_RANDOM_ADD_ITEMS_CASES=20 ZELO_RANDOM_ADD_ITEMS_MIN_PASS=16 \
  ./tests/run_add_items_random_catalog_tests.sh
npm run test:clear-cart
npm run test:agent-formatting
npm run test:discover-meals
npm run test:discover-semantic
npm run test:history-suggestions
npm run test:session-isolation
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--experimental-global-webcrypto" npm run test:whatsapp
npm run test:whatsapp-onboarding-store
npm run test:whatsapp-onboarding-swissdata
npm run test:whatsapp-onboarding-routes
npm run test:whatsapp-onboarding
npm run test:whatsapp-new-customer-discovery
npm run test:recurring-orders
npm run test:pending-options
npm run test:product-eligibility
npm run test:cart-product-eligibility
npm run test:security
npm run test:build-meal-family
npm run test:build-meal-matching
echo ""

echo "== Production onboarding configuration =="
PRODUCTION_ENV="${LOCAL_ENV_FILE:-deploy/production.env}"
if [ ! -f "$PRODUCTION_ENV" ]; then
  PRODUCTION_ENV="deploy/production.env.example"
fi

read_env_value() {
  local key="$1"
  local file="$2"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

AUTH_MODE="$(read_env_value WHATSAPP_AUTH_MODE "$PRODUCTION_ENV")"
ONBOARDING_URL="$(read_env_value WHATSAPP_ONBOARDING_URL "$PRODUCTION_ENV")"
ONBOARDING_KEY="$(read_env_value WHATSAPP_ONBOARDING_STATE_KEY "$PRODUCTION_ENV")"

if [ "$AUTH_MODE" != "otp" ]; then
  echo "ERROR: WHATSAPP_AUTH_MODE must be otp in $PRODUCTION_ENV."
  exit 1
fi
if [ -n "$ONBOARDING_URL" ] && [[ "$ONBOARDING_URL" != https://* ]]; then
  echo "ERROR: WHATSAPP_ONBOARDING_URL must use HTTPS in $PRODUCTION_ENV."
  exit 1
fi
if [ -n "$ONBOARDING_KEY" ]; then
  ONBOARDING_KEY_BYTES="$(printf '%s' "$ONBOARDING_KEY" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' ')"
  if [ "$ONBOARDING_KEY_BYTES" != "32" ]; then
    echo "ERROR: WHATSAPP_ONBOARDING_STATE_KEY must decode to exactly 32 bytes."
    exit 1
  fi
  echo "Existing 32-byte onboarding state key will be deployed (value not displayed)."
else
  echo "No local onboarding state key: deploy step 3 will generate it once on the server."
fi
echo "Onboarding URL: ${ONBOARDING_URL:-https://assistant.zelo-epicerie.ch/inscription-whatsapp (server default)}"
echo "Production onboarding configuration is ready."
echo ""

echo "== Cache archive =="
CACHE_ARCHIVE="${CACHE_ARCHIVE:-/tmp/zelo_ai_cache_$(date +%Y%m%d_%H%M%S).tgz}"
tar \
  --exclude ".cache/tmp" \
  --exclude ".cache/tmp/*" \
  --exclude ".cache/whatsapp-web-session" \
  --exclude ".cache/whatsapp-web-session/*" \
  --exclude ".cache/whatsapp-onboarding-state.json" \
  --exclude ".cache/.whatsapp-onboarding-state.json.*.tmp" \
  -czf "$CACHE_ARCHIVE" .cache
printf '%s\n' "$CACHE_ARCHIVE" > /tmp/zelo_ai_last_cache_archive.txt
echo "Cache archive created: $CACHE_ARCHIVE"
echo "Cache archive excludes: .cache/tmp, .cache/whatsapp-web-session, onboarding runtime state"
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
