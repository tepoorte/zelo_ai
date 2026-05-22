#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${ZELO_TEST_BASE_URL:=http://127.0.0.1:3041}"
: "${ZELO_TEST_USER_REF:=random-add-items-$(date +%s)}"
: "${ZELO_TEST_USERNAME:=public-contact-003@example.invalid}"
: "${ZELO_RANDOM_ADD_ITEMS_CASES:=20}"
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
export ZELO_RANDOM_ADD_ITEMS_MIN_PRODUCTS
export ZELO_RANDOM_ADD_ITEMS_MAX_PRODUCTS
export ZELO_RANDOM_ADD_ITEMS_SEED
export ZELO_RANDOM_ADD_ITEMS_MUTATE_NAMES

echo "Base URL : $ZELO_TEST_BASE_URL"
echo "User ref : $ZELO_TEST_USER_REF"
echo "Username : $ZELO_TEST_USERNAME"
echo "Cases    : $ZELO_RANDOM_ADD_ITEMS_CASES"
echo "Products : $ZELO_RANDOM_ADD_ITEMS_MIN_PRODUCTS-$ZELO_RANDOM_ADD_ITEMS_MAX_PRODUCTS per case"
echo "Seed     : $ZELO_RANDOM_ADD_ITEMS_SEED"
echo "Typos    : $ZELO_RANDOM_ADD_ITEMS_MUTATE_NAMES"
echo ""

npm run test:add-items-random
