#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

read_env_value() {
  local key="$1"
  if [[ -f .env ]]; then
    grep -E "^${key}=" .env | tail -n 1 | sed -E "s/^${key}=//; s/^\"//; s/\"$//"
  fi
}

: "${ZELO_TEST_BASE_URL:=http://127.0.0.1:3041}"
: "${ZELO_TEST_USER_REF:=random-add-items-$(date +%s)}"
: "${ZELO_TEST_USERNAME:=$(read_env_value ZELO_TEST_USERNAME)}"
: "${ZELO_TEST_USERNAME:=public-contact-003@example.invalid}"
: "${ZELO_TEST_PASSWORD:=$(read_env_value ZELO_TEST_PASSWORD)}"
: "${ZELO_RANDOM_ADD_ITEMS_CASES:=20}"
: "${ZELO_RANDOM_ADD_ITEMS_MIN_PASS:=16}"
: "${ZELO_RANDOM_ADD_ITEMS_MIN_PRODUCTS:=3}"
: "${ZELO_RANDOM_ADD_ITEMS_MAX_PRODUCTS:=6}"
: "${ZELO_RANDOM_ADD_ITEMS_SEED:=zelo-add-items-random-ci}"
: "${ZELO_RANDOM_ADD_ITEMS_MUTATE_NAMES:=1}"

if [[ -z "${ZELO_TEST_PASSWORD:-}" ]]; then
  printf 'Swissdata password for %s: ' "$ZELO_TEST_USERNAME"
  read -r -s ZELO_TEST_PASSWORD
  printf '\n'
fi

export ZELO_TEST_BASE_URL
export ZELO_TEST_USER_REF
export ZELO_TEST_USERNAME
export ZELO_TEST_PASSWORD
export ZELO_RANDOM_ADD_ITEMS_CASES
export ZELO_RANDOM_ADD_ITEMS_MIN_PASS
export ZELO_RANDOM_ADD_ITEMS_MIN_PRODUCTS
export ZELO_RANDOM_ADD_ITEMS_MAX_PRODUCTS
export ZELO_RANDOM_ADD_ITEMS_SEED
export ZELO_RANDOM_ADD_ITEMS_MUTATE_NAMES

echo "Base URL : $ZELO_TEST_BASE_URL"
echo "User ref : $ZELO_TEST_USER_REF"
echo "Username : $ZELO_TEST_USERNAME"
echo "Cases    : $ZELO_RANDOM_ADD_ITEMS_CASES"
echo "Min pass : $ZELO_RANDOM_ADD_ITEMS_MIN_PASS"
echo "Products : $ZELO_RANDOM_ADD_ITEMS_MIN_PRODUCTS-$ZELO_RANDOM_ADD_ITEMS_MAX_PRODUCTS per case"
echo "Seed     : $ZELO_RANDOM_ADD_ITEMS_SEED"
echo "Typos    : $ZELO_RANDOM_ADD_ITEMS_MUTATE_NAMES"
echo ""

RESULTS_FILE="$(mktemp "${TMPDIR:-/tmp}/zelo-random-add-items.XXXXXX")"
trap 'rm -f "$RESULTS_FILE"' EXIT

set +e
npm run test:add-items-random 2>&1 | tee "$RESULTS_FILE"
set -e

SUMMARY_LINE="$(grep -E '\[ADD_ITEMS_RANDOM\] completed pass=[0-9]+ fail=[0-9]+' "$RESULTS_FILE" | tail -n 1 || true)"
PASSED="$(printf '%s\n' "$SUMMARY_LINE" | sed -E 's/.*pass=([0-9]+).*/\1/')"
FAILED="$(printf '%s\n' "$SUMMARY_LINE" | sed -E 's/.*fail=([0-9]+).*/\1/')"

if [[ ! "$PASSED" =~ ^[0-9]+$ ]] || [[ ! "$FAILED" =~ ^[0-9]+$ ]]; then
  echo "ERROR: random catalog test did not emit a readable pass/fail summary."
  exit 1
fi
TOTAL=$((PASSED + FAILED))
if (( TOTAL != ZELO_RANDOM_ADD_ITEMS_CASES )); then
  echo "ERROR: random catalog summary contains ${TOTAL} cases; expected ${ZELO_RANDOM_ADD_ITEMS_CASES}."
  exit 1
fi
if (( PASSED < ZELO_RANDOM_ADD_ITEMS_MIN_PASS )); then
  echo "ERROR: random catalog result ${PASSED}/${TOTAL} is below the required ${ZELO_RANDOM_ADD_ITEMS_MIN_PASS}/${ZELO_RANDOM_ADD_ITEMS_CASES}."
  exit 1
fi

echo "Random catalog gate accepted: ${PASSED}/${TOTAL} (required >= ${ZELO_RANDOM_ADD_ITEMS_MIN_PASS}/${ZELO_RANDOM_ADD_ITEMS_CASES})."
