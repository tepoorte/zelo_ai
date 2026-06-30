#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

PROXY_PORT="${META_PROXY_PORT:-3999}"
PROXY_TARGET="${META_PROXY_TARGET:-http://127.0.0.1:3041/integrations/meta/whatsapp/webhook}"
TUNNEL_PROTOCOL="${META_TUNNEL_PROTOCOL:-http2}"
TMP_ROOT="${TMPDIR:-/tmp}/zelo_meta_whatsapp_demo"
PROXY_LOG="$TMP_ROOT/meta-webhook-proxy.log"
TUNNEL_LOG="$TMP_ROOT/cloudflared.log"
RESTART_DOCKER=1

for arg in "$@"; do
  case "$arg" in
    --no-docker-restart)
      RESTART_DOCKER=0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--no-docker-restart]" >&2
      exit 2
      ;;
  esac
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command docker
require_command node
require_command curl
require_command cloudflared
require_command dig

if [ ! -f .env ]; then
  echo "Missing .env in $ROOT_DIR" >&2
  exit 1
fi

mkdir -p "$TMP_ROOT"
: > "$PROXY_LOG"
: > "$TUNNEL_LOG"

read_env_value() {
  local key="$1"
  KEY="$key" node --input-type=module <<'NODE'
import fs from "node:fs";

const key = process.env.KEY;
const values = {};
const text = fs.readFileSync(".env", "utf8");
for (const rawLine of text.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const index = line.indexOf("=");
  if (index < 0) continue;
  const name = line.slice(0, index).trim();
  let value = line.slice(index + 1).trim();
  value = value.replace(/^["']|["']$/g, "");
  values[name] = value;
}

process.stdout.write(values[key] || "");
NODE
}

urlencode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1] || ""))' "$1"
}

resolve_public_ip() {
  local host="$1"
  local ip=""
  ip="$(dig @1.1.1.1 +short "$host" A 2>/dev/null | grep -E '^[0-9.]+$' | head -n 1 || true)"
  if [ -z "$ip" ]; then
    ip="$(dig @8.8.8.8 +short "$host" A 2>/dev/null | grep -E '^[0-9.]+$' | head -n 1 || true)"
  fi
  printf '%s' "$ip"
}

curl_challenge() {
  local url="$1"
  local host="$2"
  local ip=""

  if curl -fsS "$url" 2>/dev/null | grep -qx "zelo_ok"; then
    return 0
  fi

  ip="$(resolve_public_ip "$host")"
  if [ -z "$ip" ]; then
    return 1
  fi

  curl -fsS --resolve "${host}:443:${ip}" "$url" 2>/dev/null | grep -qx "zelo_ok"
}

cleanup() {
  if [ -n "${TUNNEL_PID:-}" ] && kill -0 "$TUNNEL_PID" >/dev/null 2>&1; then
    kill "$TUNNEL_PID" >/dev/null 2>&1 || true
  fi
  if [ "${STARTED_PROXY:-0}" = "1" ] && [ -n "${PROXY_PID:-}" ] && kill -0 "$PROXY_PID" >/dev/null 2>&1; then
    kill "$PROXY_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "== Zelo AI local container =="
if [ "$RESTART_DOCKER" = "1" ]; then
  ./dockerRes_login.sh
else
  echo "Skipped Docker restart (--no-docker-restart)."
fi

echo "Waiting for Zelo AI health..."
for _ in $(seq 1 30); do
  if docker exec zelo_ai wget -qO- http://127.0.0.1:3041/health >/dev/null 2>&1; then
    echo "Zelo AI health OK."
    break
  fi
  sleep 1
done

if ! docker exec zelo_ai wget -qO- http://127.0.0.1:3041/health >/dev/null 2>&1; then
  echo "Zelo AI health did not become ready." >&2
  docker logs --tail=80 zelo_ai >&2 || true
  exit 1
fi

echo "== Local Meta webhook proxy =="
if curl -fsS "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1; then
  echo "Reusing existing proxy on 127.0.0.1:${PROXY_PORT}."
  STARTED_PROXY=0
else
  STARTED_PROXY=1
  META_PROXY_PORT="$PROXY_PORT" META_PROXY_TARGET="$PROXY_TARGET" \
    node .cache/tmp/meta-webhook-proxy.mjs > "$PROXY_LOG" 2>&1 &
  PROXY_PID=$!

  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1; then
      echo "Proxy started on 127.0.0.1:${PROXY_PORT}."
      break
    fi
    sleep 0.5
  done

  if ! curl -fsS "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1; then
    echo "Proxy did not start. Log:" >&2
    cat "$PROXY_LOG" >&2
    exit 1
  fi
fi

VERIFY_TOKEN="$(read_env_value META_VERIFY_TOKEN)"
if [ -z "$VERIFY_TOKEN" ]; then
  echo "Missing META_VERIFY_TOKEN in .env." >&2
  exit 1
fi
VERIFY_TOKEN_ENCODED="$(urlencode "$VERIFY_TOKEN")"

echo "== Cloudflare temporary tunnel =="
PUBLIC_URL=""
CALLBACK_URL=""
CHALLENGE_OK=0

for attempt in $(seq 1 5); do
  : > "$TUNNEL_LOG"
  echo "Starting Cloudflare tunnel attempt ${attempt}/5..."
  cloudflared tunnel --protocol "$TUNNEL_PROTOCOL" --url "http://127.0.0.1:${PROXY_PORT}" > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!

  PUBLIC_URL=""
  for _ in $(seq 1 60); do
    PUBLIC_URL="$(grep -aEo 'https://[-a-zA-Z0-9]+\.trycloudflare\.com' "$TUNNEL_LOG" | tail -n 1 || true)"
    if [ -n "$PUBLIC_URL" ]; then
      break
    fi
    if ! kill -0 "$TUNNEL_PID" >/dev/null 2>&1; then
      echo "cloudflared exited before exposing an URL. Log:" >&2
      cat "$TUNNEL_LOG" >&2
      exit 1
    fi
    sleep 1
  done

  if [ -z "$PUBLIC_URL" ]; then
    echo "Could not find Cloudflare tunnel URL for attempt ${attempt}." >&2
    kill "$TUNNEL_PID" >/dev/null 2>&1 || true
    TUNNEL_PID=""
    continue
  fi

  CALLBACK_URL="${PUBLIC_URL}/webhook"
  PUBLIC_HOST="${PUBLIC_URL#https://}"
  echo "Tunnel URL: $PUBLIC_URL"
  echo "Webhook callback: $CALLBACK_URL"
  echo "Testing public webhook challenge..."

  CHALLENGE_URL="${CALLBACK_URL}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN_ENCODED}&hub.challenge=zelo_ok"
  for _ in $(seq 1 45); do
    if curl_challenge "$CHALLENGE_URL" "$PUBLIC_HOST"; then
      CHALLENGE_OK=1
      break
    fi
    if ! kill -0 "$TUNNEL_PID" >/dev/null 2>&1; then
      echo "cloudflared exited while testing webhook challenge. Log:" >&2
      cat "$TUNNEL_LOG" >&2
      exit 1
    fi
    sleep 2
  done

  if [ "$CHALLENGE_OK" = "1" ]; then
    break
  fi

  echo "Public webhook challenge failed for attempt ${attempt}; trying another tunnel..."
  kill "$TUNNEL_PID" >/dev/null 2>&1 || true
  TUNNEL_PID=""
done

if [ "$CHALLENGE_OK" != "1" ]; then
  echo "Public webhook challenge failed after multiple tunnel attempts." >&2
  echo "Last Cloudflare log:" >&2
  tail -n 80 "$TUNNEL_LOG" >&2 || true
  exit 1
fi
echo "Public webhook challenge OK."

echo "== Updating Meta webhook subscription =="
CALLBACK_URL="$CALLBACK_URL" node --input-type=module <<'NODE'
import fs from "node:fs";

function parseEnv(path) {
  const output = {};
  const text = fs.readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    value = value.replace(/^["']|["']$/g, "");
    output[key] = value;
  }
  return output;
}

const env = parseEnv(".env");
const graphVersion = env.META_GRAPH_VERSION || "v23.0";
const graphToken = env.META_GRAPH_TOKEN;
const appSecret = env.META_APP_SECRET;
const verifyToken = env.META_VERIFY_TOKEN;
const wabaId = env.META_WHATSAPP_BUSINESS_ACCOUNT_ID;
const callbackUrl = process.env.CALLBACK_URL;

for (const [name, value] of Object.entries({
  META_GRAPH_TOKEN: graphToken,
  META_APP_SECRET: appSecret,
  META_VERIFY_TOKEN: verifyToken,
  META_WHATSAPP_BUSINESS_ACCOUNT_ID: wabaId,
  CALLBACK_URL: callbackUrl,
})) {
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
}

async function graph(path, token, options = {}) {
  const separator = path.includes("?") ? "&" : "?";
  const url = `https://graph.facebook.com/${graphVersion}/${path}${separator}access_token=${encodeURIComponent(token)}`;
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`Meta Graph ${path} failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

const subscribed = await graph(`${wabaId}/subscribed_apps`, graphToken);
const appId =
  env.META_APP_ID ||
  subscribed.data?.[0]?.whatsapp_business_api_data?.id ||
  subscribed.data?.[0]?.id;

if (!appId) {
  throw new Error("Could not resolve Meta app id from subscribed_apps. Set META_APP_ID in .env.");
}

const appToken = `${appId}|${appSecret}`;
const body = new URLSearchParams({
  object: "whatsapp_business_account",
  callback_url: callbackUrl,
  verify_token: verifyToken,
  fields: "messages",
});

const update = await graph(`${appId}/subscriptions`, appToken, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body,
});

if (!update.success) {
  throw new Error(`Meta subscription update did not return success: ${JSON.stringify(update)}`);
}

const verify = await graph(`${appId}/subscriptions`, appToken);
const whatsappSub = (verify.data || []).find((sub) => sub.object === "whatsapp_business_account");

console.log(
  JSON.stringify(
    {
      ok: true,
      appId,
      callback_url: whatsappSub?.callback_url,
      active: whatsappSub?.active,
      fields: whatsappSub?.fields?.map((field) => field.name),
    },
    null,
    2
  )
);
NODE

echo
echo "Ready. Send a WhatsApp message to the Meta test number now."
echo "Keep this script running. Press Ctrl+C to close the temporary tunnel."
echo
echo "Useful local logs:"
echo "  docker logs -f --tail=120 zelo_ai"
echo "  tail -f $TUNNEL_LOG"
echo "  tail -f $PROXY_LOG"

wait "$TUNNEL_PID"
