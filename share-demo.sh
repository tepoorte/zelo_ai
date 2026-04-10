#!/usr/bin/env sh

set -eu

PORT="${1:-3041}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed."
  echo "Install it first, for example:"
  echo "  brew install cloudflare/cloudflare/cloudflared"
  exit 1
fi

echo "Sharing Zelo AI demo on http://localhost:${PORT}"
echo ""
echo "Important:"
echo "- Keep this terminal open while your boss tests the app."
echo "- The current frontend still uses a shared userRef (local-dev)."
echo "- Do not use the app at the same time during the demo."
echo ""
echo "Starting Cloudflare tunnel..."
echo ""

exec cloudflared tunnel --url "http://localhost:${PORT}"
