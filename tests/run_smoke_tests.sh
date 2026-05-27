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
: "${ZELO_TEST_USER_REF:=smoke-$(date +%s)}"
: "${ZELO_TEST_USERNAME:=$(read_env_value ZELO_TEST_USERNAME)}"
: "${ZELO_TEST_USERNAME:=public-contact-003@example.invalid}"
: "${ZELO_TEST_PASSWORD:=$(read_env_value ZELO_TEST_PASSWORD)}"

if [[ -z "${ZELO_TEST_PASSWORD:-}" ]]; then
  printf 'Swissdata password for %s: ' "$ZELO_TEST_USERNAME"
  read -r -s ZELO_TEST_PASSWORD
  printf '\n'
fi

export ZELO_TEST_BASE_URL
export ZELO_TEST_USER_REF
export ZELO_TEST_USERNAME
export ZELO_TEST_PASSWORD

echo "Base URL : $ZELO_TEST_BASE_URL"
echo "User ref : $ZELO_TEST_USER_REF"
echo "Username : $ZELO_TEST_USERNAME"
echo ""

npm run test:smoke
