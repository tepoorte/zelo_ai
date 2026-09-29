#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="${VERSION:-}"
DNS_PREFLIGHT_ONLY="${DNS_PREFLIGHT_ONLY:-0}"

if [ -z "$VERSION" ] && [ "$DNS_PREFLIGHT_ONLY" != "1" ]; then
  echo "Missing VERSION."
  echo "Usage: VERSION=1.0.0 ./deploy/03-build-push-and-server-deploy.sh"
  exit 1
fi
if [ -z "$VERSION" ]; then
  VERSION="<not required for DNS preflight>"
fi

DOCKER_IMAGE="${DOCKER_IMAGE:-hub.mintello.com/ai-zelo}"
SERVER_HOST="${SERVER_HOST:-195.15.215.113}"
SERVER_PORT="${SERVER_PORT:-5222}"
SERVER_USER="${SERVER_USER:-ubuntu}"
SERVER_RUNTIME_DIR="${SERVER_RUNTIME_DIR:-/home/ubuntu/zelo-ai}"
LOCAL_COMPOSE_FILE="${LOCAL_COMPOSE_FILE:-deploy/docker-compose.with-ollama.yml}"
if [ -z "${LOCAL_ENV_FILE:-}" ]; then
  if [ -f deploy/production.env ]; then
    LOCAL_ENV_FILE="deploy/production.env"
  else
    LOCAL_ENV_FILE="deploy/production.env.example"
  fi
fi
REMOTE_COMPOSE_FILE="${REMOTE_COMPOSE_FILE:-docker-compose.yml}"
REMOTE_COMPOSE_STAGING="${REMOTE_COMPOSE_FILE}.incoming"
REMOTE_ENV_STAGING=".env.template.incoming"
PROXYNET="${PROXYNET:-traefik-net}"

# Do not default to ai.zelo-epicerie.ch: it currently points to another server.
AI_HOST="${AI_HOST:-assistant.zelo-epicerie.ch}"
CACHE_ARCHIVE="${CACHE_ARCHIVE:-}"
REPLACE_SERVER_CACHE="${REPLACE_SERVER_CACHE:-0}"

print_dns_instructions() {
  cat <<EOF
== DNS required before deploy ==
This script does not create DNS records automatically.
DNS must be created in the domain provider panel, or through a provider API token
that is not configured in this project.

Create this record before deploying:
  Type: A
  Name: ${AI_HOST%%.*}
  Value: $SERVER_HOST
  TTL: 300

Expected result:
  $AI_HOST -> $SERVER_HOST

If the domain is managed by Infomaniak:
  Manager > Domaines > zelo-epicerie.ch > Zone DNS > Ajouter une entree

To verify before deploying:
  dig +short $AI_HOST

EOF
}

if [ -z "$CACHE_ARCHIVE" ] && [ -f /tmp/zelo_ai_last_cache_archive.txt ]; then
  CACHE_ARCHIVE="$(cat /tmp/zelo_ai_last_cache_archive.txt)"
fi

if [ "$DNS_PREFLIGHT_ONLY" != "1" ]; then
  if [ -z "$CACHE_ARCHIVE" ] || [ ! -f "$CACHE_ARCHIVE" ]; then
    echo "Missing CACHE_ARCHIVE."
    echo "Run ./deploy/01-local-preflight.sh first, or pass CACHE_ARCHIVE=/path/to/archive.tgz."
    exit 1
  fi

  if [ ! -f "$LOCAL_COMPOSE_FILE" ]; then
    echo "Missing local compose file: $LOCAL_COMPOSE_FILE"
    exit 1
  fi

  if [ ! -f "$LOCAL_ENV_FILE" ]; then
    echo "Missing local env template: $LOCAL_ENV_FILE"
    exit 1
  fi
fi

ARCHIVE_BASENAME=""
if [ -n "$CACHE_ARCHIVE" ]; then
  ARCHIVE_BASENAME="$(basename "$CACHE_ARCHIVE")"
fi

echo "== Zelo AI image-based production deploy =="
echo "Docker image: $DOCKER_IMAGE:$VERSION"
echo "AI host: $AI_HOST"
echo "Server: $SERVER_USER@$SERVER_HOST:$SERVER_PORT"
echo "Server runtime dir: $SERVER_RUNTIME_DIR"
echo "Local compose: $LOCAL_COMPOSE_FILE"
echo "Local env template: $LOCAL_ENV_FILE"
echo "Cache archive: ${CACHE_ARCHIVE:-<not required for DNS preflight>}"
echo "Replace existing server .cache: $REPLACE_SERVER_CACHE"
echo ""

print_dns_instructions

echo "== Server read-only preflight =="
ssh -p "$SERVER_PORT" "$SERVER_USER@$SERVER_HOST" \
  AI_HOST="$AI_HOST" \
  SERVER_HOST="$SERVER_HOST" \
  PROXYNET="$PROXYNET" \
  'bash -s' <<'REMOTE_PREFLIGHT'
set -euo pipefail

echo "Server: $(hostname)"
echo "Docker compose: $(docker compose version --short 2>/dev/null || docker-compose --version 2>/dev/null || true)"

if ! docker network inspect "$PROXYNET" >/dev/null 2>&1; then
  echo "ERROR: Docker network '$PROXYNET' does not exist on server."
  exit 1
fi

if [ ! -f "$HOME/.docker/config.json" ]; then
  echo "ERROR: Docker registry auth is missing on server (~/.docker/config.json)."
  exit 1
fi

RESOLVED_IPS="$(getent ahosts "$AI_HOST" | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
echo "DNS $AI_HOST -> ${RESOLVED_IPS:-<no result>}"
case " $RESOLVED_IPS " in
  *" $SERVER_HOST "*) ;;
  *)
    echo "ERROR: $AI_HOST does not resolve to $SERVER_HOST."
    echo "Create/update DNS first, for example: $AI_HOST A $SERVER_HOST"
    echo "Nothing has been deployed."
    exit 1
    ;;
esac

if docker ps --format '{{.Names}}' | grep -Eq '^(zelo_ai|zelo-ai-ollama)$'; then
  echo "Existing Zelo AI containers detected; they will be updated by docker compose."
else
  echo "No existing Zelo AI containers detected."
fi
REMOTE_PREFLIGHT
echo ""

if [ "$DNS_PREFLIGHT_ONLY" = "1" ]; then
  echo "DNS preflight completed. Exiting because DNS_PREFLIGHT_ONLY=1."
  exit 0
fi

read -r -p "This will push Docker image and deploy on production server. Type YES: " CONFIRM
if [ "$CONFIRM" != "YES" ]; then
  echo "Aborted before build."
  exit 1
fi

echo "== Docker login local =="
docker login hub.mintello.com
echo ""

echo "== Build and push linux/amd64 image =="
docker buildx build \
  --platform=linux/amd64 \
  -t "$DOCKER_IMAGE:$VERSION" \
  -t "$DOCKER_IMAGE:latest" \
  --push \
  .
echo ""

echo "== Prepare runtime directory on server =="
ssh -p "$SERVER_PORT" "$SERVER_USER@$SERVER_HOST" \
  SERVER_RUNTIME_DIR="$SERVER_RUNTIME_DIR" \
  REMOTE_COMPOSE_STAGING="$REMOTE_COMPOSE_STAGING" \
  REMOTE_ENV_STAGING="$REMOTE_ENV_STAGING" \
  ARCHIVE_BASENAME="$ARCHIVE_BASENAME" \
  'bash -s' <<'REMOTE_MKDIR'
set -euo pipefail
umask 077
mkdir -p -m 700 "$SERVER_RUNTIME_DIR"
chmod 700 "$SERVER_RUNTIME_DIR"
touch \
  "$SERVER_RUNTIME_DIR/$REMOTE_COMPOSE_STAGING" \
  "$SERVER_RUNTIME_DIR/$REMOTE_ENV_STAGING" \
  "$SERVER_RUNTIME_DIR/$ARCHIVE_BASENAME"
chmod 600 \
  "$SERVER_RUNTIME_DIR/$REMOTE_COMPOSE_STAGING" \
  "$SERVER_RUNTIME_DIR/$REMOTE_ENV_STAGING" \
  "$SERVER_RUNTIME_DIR/$ARCHIVE_BASENAME"
REMOTE_MKDIR
echo ""

echo "== Copy runtime files to server =="
scp -P "$SERVER_PORT" "$LOCAL_COMPOSE_FILE" "$SERVER_USER@$SERVER_HOST:$SERVER_RUNTIME_DIR/$REMOTE_COMPOSE_STAGING"
scp -P "$SERVER_PORT" "$LOCAL_ENV_FILE" "$SERVER_USER@$SERVER_HOST:$SERVER_RUNTIME_DIR/$REMOTE_ENV_STAGING"
scp -P "$SERVER_PORT" "$CACHE_ARCHIVE" "$SERVER_USER@$SERVER_HOST:$SERVER_RUNTIME_DIR/$ARCHIVE_BASENAME"
ssh -p "$SERVER_PORT" "$SERVER_USER@$SERVER_HOST" \
  SERVER_RUNTIME_DIR="$SERVER_RUNTIME_DIR" \
  REMOTE_COMPOSE_STAGING="$REMOTE_COMPOSE_STAGING" \
  REMOTE_ENV_STAGING="$REMOTE_ENV_STAGING" \
  ARCHIVE_BASENAME="$ARCHIVE_BASENAME" \
  'bash -s' <<'REMOTE_PERMISSIONS'
set -euo pipefail
chmod 700 "$SERVER_RUNTIME_DIR"
chmod 600 \
  "$SERVER_RUNTIME_DIR/$REMOTE_COMPOSE_STAGING" \
  "$SERVER_RUNTIME_DIR/$REMOTE_ENV_STAGING" \
  "$SERVER_RUNTIME_DIR/$ARCHIVE_BASENAME"
REMOTE_PERMISSIONS
echo ""

echo "== Deploy runtime on server =="
ssh -p "$SERVER_PORT" "$SERVER_USER@$SERVER_HOST" \
  VERSION="$VERSION" \
  AI_HOST="$AI_HOST" \
  SERVER_RUNTIME_DIR="$SERVER_RUNTIME_DIR" \
  REMOTE_COMPOSE_FILE="$REMOTE_COMPOSE_FILE" \
  REMOTE_COMPOSE_STAGING="$REMOTE_COMPOSE_STAGING" \
  REMOTE_ENV_STAGING="$REMOTE_ENV_STAGING" \
  ARCHIVE_BASENAME="$ARCHIVE_BASENAME" \
  REPLACE_SERVER_CACHE="$REPLACE_SERVER_CACHE" \
  'bash -s' <<'REMOTE_SCRIPT'
set -euo pipefail
umask 077

cd "$SERVER_RUNTIME_DIR"
BACKUP_DIR="$HOME/zelo-ai-backups"
mkdir -p -m 700 "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date +%Y%m%d_%H%M%S)"
RESTORE_CACHE=1
HAS_EXISTING_ONBOARDING_STATE=0
ENV_CANDIDATE=".env.incoming"
CACHE_STAGE_ROOT=""
ARCHIVE_LISTING=""

cleanup_staging() {
  rm -f -- "$ENV_CANDIDATE" "$REMOTE_COMPOSE_STAGING" "$REMOTE_ENV_STAGING"
  if [ -n "$ARCHIVE_LISTING" ]; then
    rm -f -- "$ARCHIVE_LISTING"
  fi
  if [ -n "$CACHE_STAGE_ROOT" ] && [ -d "$CACHE_STAGE_ROOT" ]; then
    rm -rf -- "$CACHE_STAGE_ROOT"
  fi
}
trap cleanup_staging EXIT HUP INT TERM

echo "== Validate incoming runtime files without touching the active runtime =="
if [ ! -s "$REMOTE_COMPOSE_STAGING" ] || [ ! -s "$REMOTE_ENV_STAGING" ]; then
  echo "ERROR: incoming compose or env template is missing/empty."
  exit 1
fi

if [ -d .cache ]; then
  if [ -f .cache/whatsapp-onboarding-state.json ]; then
    HAS_EXISTING_ONBOARDING_STATE=1
  fi
  if [ "$REPLACE_SERVER_CACHE" != "1" ]; then
    RESTORE_CACHE=0
  fi
fi

read_env_value() {
  local key="$1"
  local file="$2"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

write_env_value() {
  local key="$1"
  local value="$2"
  local file="$3"
  local escaped
  escaped="$(printf '%s\n' "$value" | sed -e 's/[\/&]/\\&/g')"
  if grep -q "^${key}=" "$file"; then
    sed -i "s/^${key}=.*/${key}=${escaped}/" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

echo "== Render and validate candidate environment =="
cp "$REMOTE_ENV_STAGING" "$ENV_CANDIDATE"
chmod 600 "$ENV_CANDIDATE"
sed -i "s/^VERSION=.*/VERSION=$VERSION/" "$ENV_CANDIDATE"
sed -i "s/^AI_HOST=.*/AI_HOST=$AI_HOST/" "$ENV_CANDIDATE"

if [ -f .env ]; then
  echo "== Preserve existing production-only secrets when template leaves them empty =="

  PRESERVE_IF_TEMPLATE_EMPTY_KEYS="
META_VERIFY_TOKEN
META_APP_SECRET
META_GRAPH_TOKEN
META_WHATSAPP_PHONE_NUMBER_ID
META_WHATSAPP_BUSINESS_ACCOUNT_ID
WHATSAPP_ADMIN_TOKEN
WHATSAPP_ONBOARDING_URL
WHATSAPP_ONBOARDING_TTL_MINUTES
WHATSAPP_ONBOARDING_MAX_ATTEMPTS
WHATSAPP_ONBOARDING_LOCK_MINUTES
WHATSAPP_ONBOARDING_STATE_KEY
WHATSAPP_TEST_PHONE
WHATSAPP_ALLOWED_PHONES
SWISSDATA_ADMIN_TOKEN
SWISSDATA_ADMIN_USERNAME
SWISSDATA_ADMIN_PASSWORD
SMTP_HOST
SMTP_PORT
SMTP_SECURE
SMTP_USER
SMTP_PASS
SMTP_FROM
OPENAI_API_KEY
DOCKERUSERNAME
DOCKERPASSWORD
TOKEN
TWILIO_SWISSDATA_USERNAME
TWILIO_SWISSDATA_PASSWORD
"

  PRESERVED_COUNT=0
  for KEY in $PRESERVE_IF_TEMPLATE_EMPTY_KEYS; do
    NEW_VALUE="$(read_env_value "$KEY" "$ENV_CANDIDATE")"
    OLD_VALUE="$(read_env_value "$KEY" .env)"
    if [ -z "$NEW_VALUE" ] && [ -n "$OLD_VALUE" ]; then
      write_env_value "$KEY" "$OLD_VALUE" "$ENV_CANDIDATE"
      PRESERVED_COUNT=$((PRESERVED_COUNT + 1))
    fi
  done
  echo "Preserved $PRESERVED_COUNT existing secret/config values."
elif [ "$HAS_EXISTING_ONBOARDING_STATE" = "1" ]; then
  echo "ERROR: encrypted WhatsApp onboarding state exists but the previous .env is unavailable."
  echo "Restore the previous .env before deploying so its encryption key can be verified."
  exit 1
fi

echo "== Complete and validate WhatsApp onboarding configuration =="
ONBOARDING_URL="$(read_env_value WHATSAPP_ONBOARDING_URL "$ENV_CANDIDATE")"
if [ -z "$ONBOARDING_URL" ]; then
  ONBOARDING_URL="https://$AI_HOST/inscription-whatsapp"
  write_env_value WHATSAPP_ONBOARDING_URL "$ONBOARDING_URL" "$ENV_CANDIDATE"
fi
case "$ONBOARDING_URL" in
  https://*) ;;
  *)
    echo "ERROR: WHATSAPP_ONBOARDING_URL must use HTTPS in production."
    exit 1
    ;;
esac

for DEFAULT_ENTRY in \
  "WHATSAPP_ONBOARDING_TTL_MINUTES=30" \
  "WHATSAPP_ONBOARDING_MAX_ATTEMPTS=5" \
  "WHATSAPP_ONBOARDING_LOCK_MINUTES=15"; do
  DEFAULT_KEY="${DEFAULT_ENTRY%%=*}"
  DEFAULT_VALUE="${DEFAULT_ENTRY#*=}"
  if [ -z "$(read_env_value "$DEFAULT_KEY" "$ENV_CANDIDATE")" ]; then
    write_env_value "$DEFAULT_KEY" "$DEFAULT_VALUE" "$ENV_CANDIDATE"
  fi
done

ONBOARDING_STATE_KEY="$(read_env_value WHATSAPP_ONBOARDING_STATE_KEY "$ENV_CANDIDATE")"
if [ -z "$ONBOARDING_STATE_KEY" ]; then
  if [ "$HAS_EXISTING_ONBOARDING_STATE" = "1" ]; then
    echo "ERROR: encrypted WhatsApp onboarding state exists but its previous key is unavailable."
    exit 1
  fi
  ONBOARDING_STATE_KEY="$(openssl rand -base64 32 | tr -d '\n')"
  write_env_value WHATSAPP_ONBOARDING_STATE_KEY "$ONBOARDING_STATE_KEY" "$ENV_CANDIDATE"
  echo "Generated a new persistent onboarding state key on the server (value not displayed)."
else
  echo "Using the persistent onboarding state key already configured (value not displayed)."
fi

ONBOARDING_KEY_BYTES="$(printf '%s' "$ONBOARDING_STATE_KEY" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' ')"
if [ "$ONBOARDING_KEY_BYTES" != "32" ]; then
  echo "ERROR: WHATSAPP_ONBOARDING_STATE_KEY must decode to exactly 32 bytes."
  exit 1
fi

if [ "$HAS_EXISTING_ONBOARDING_STATE" = "1" ]; then
  OLD_ONBOARDING_STATE_KEY="$(read_env_value WHATSAPP_ONBOARDING_STATE_KEY .env)"
  if [ -z "$OLD_ONBOARDING_STATE_KEY" ] || [ "$OLD_ONBOARDING_STATE_KEY" != "$ONBOARDING_STATE_KEY" ]; then
    echo "ERROR: WHATSAPP_ONBOARDING_STATE_KEY changed while encrypted onboarding state exists."
    echo "Keep the existing key for this deploy; rotate only after active links have expired."
    exit 1
  fi
fi

if [ "$(read_env_value WHATSAPP_AUTH_MODE "$ENV_CANDIDATE")" != "otp" ]; then
  echo "ERROR: WHATSAPP_AUTH_MODE must be otp in production."
  exit 1
fi
chmod 600 "$ENV_CANDIDATE"
echo "Candidate WhatsApp onboarding configuration is ready."

echo "== Validate cache archive =="
ARCHIVE_LISTING="$(mktemp "$SERVER_RUNTIME_DIR/.cache-archive-list.XXXXXX")"
chmod 600 "$ARCHIVE_LISTING"
if ! tar -tzf "$ARCHIVE_BASENAME" > "$ARCHIVE_LISTING"; then
  echo "ERROR: cache archive is unreadable or corrupt."
  exit 1
fi
if grep -E '^\.cache/(tmp|whatsapp-web-session|whatsapp-onboarding-state\.json)(/|$)' "$ARCHIVE_LISTING" >/dev/null; then
  echo "ERROR: cache archive contains local-only runtime/session state."
  echo "Re-run ./deploy/01-local-preflight.sh to create a clean cache archive."
  exit 1
fi
if grep -E '(^/|(^|/)\.\.(/|$))' "$ARCHIVE_LISTING" >/dev/null; then
  echo "ERROR: cache archive contains an unsafe path."
  exit 1
fi
if ! grep -E '^\.cache(/|$)' "$ARCHIVE_LISTING" >/dev/null; then
  echo "ERROR: cache archive does not contain a .cache directory."
  exit 1
fi

if [ "$RESTORE_CACHE" = "1" ]; then
  CACHE_STAGE_ROOT="$(mktemp -d "$SERVER_RUNTIME_DIR/.cache-stage.XXXXXX")"
  chmod 700 "$CACHE_STAGE_ROOT"
  tar -xzf "$ARCHIVE_BASENAME" -C "$CACHE_STAGE_ROOT"
  if [ ! -d "$CACHE_STAGE_ROOT/.cache" ]; then
    echo "ERROR: cache archive did not create a staged .cache directory."
    exit 1
  fi
  chmod 700 "$CACHE_STAGE_ROOT/.cache"
  if [ "$HAS_EXISTING_ONBOARDING_STATE" = "1" ]; then
    cp .cache/whatsapp-onboarding-state.json "$CACHE_STAGE_ROOT/.cache/whatsapp-onboarding-state.json"
    chmod 600 "$CACHE_STAGE_ROOT/.cache/whatsapp-onboarding-state.json"
  fi
else
  echo "Existing server .cache will remain active."
fi

echo "== Validate candidate compose =="
docker compose --env-file "$ENV_CANDIDATE" -f "$REMOTE_COMPOSE_STAGING" config >/dev/null

echo "== Backup existing runtime files =="
if [ -f .env ]; then
  cp .env "$BACKUP_DIR/zelo_ai_env_before_$STAMP.env"
  chmod 600 "$BACKUP_DIR/zelo_ai_env_before_$STAMP.env"
  echo "Backed up .env to $BACKUP_DIR/zelo_ai_env_before_$STAMP.env"
fi
if [ -f .env.template ]; then
  cp .env.template "$BACKUP_DIR/zelo_ai_env_template_before_$STAMP.env"
  chmod 600 "$BACKUP_DIR/zelo_ai_env_template_before_$STAMP.env"
fi
if [ -f "$REMOTE_COMPOSE_FILE" ]; then
  cp "$REMOTE_COMPOSE_FILE" "$BACKUP_DIR/zelo_ai_compose_before_$STAMP.yml"
  chmod 600 "$BACKUP_DIR/zelo_ai_compose_before_$STAMP.yml"
  echo "Backed up compose to $BACKUP_DIR/zelo_ai_compose_before_$STAMP.yml"
fi
if [ -d .cache ]; then
  CACHE_BACKUP="$BACKUP_DIR/zelo_ai_cache_before_$STAMP.tgz"
  # The application container runs as root and deliberately writes the
  # encrypted onboarding state with mode 0600. Archive through passwordless
  # sudo without changing the live file's owner or permissions, then hand the
  # resulting archive back to the deployment user.
  sudo -n tar -czf "$CACHE_BACKUP" .cache
  sudo -n chown "$(id -u):$(id -g)" "$CACHE_BACKUP"
  chmod 600 "$CACHE_BACKUP"
  echo "Backed up .cache to $CACHE_BACKUP"
fi

echo "== Promote validated runtime files =="
mv "$REMOTE_COMPOSE_STAGING" "$REMOTE_COMPOSE_FILE"
mv "$REMOTE_ENV_STAGING" .env.template
mv "$ENV_CANDIDATE" .env
chmod 600 "$REMOTE_COMPOSE_FILE" .env.template .env

if [ "$RESTORE_CACHE" = "1" ]; then
  if [ -d .cache ]; then
    mv .cache "$BACKUP_DIR/zelo_ai_cache_dir_before_$STAMP"
    echo "Existing .cache moved to $BACKUP_DIR/zelo_ai_cache_dir_before_$STAMP"
  fi
  mv "$CACHE_STAGE_ROOT/.cache" .cache
  chmod 700 .cache
  echo "Validated cache archive promoted."
  if [ "$HAS_EXISTING_ONBOARDING_STATE" = "1" ]; then
    echo "Preserved the server WhatsApp onboarding state across cache replacement."
  fi
else
  echo "Skipped cache promotion because server .cache already exists."
fi
find .cache -maxdepth 1 -type f -name "*.json" | sort
du -sh .cache

echo "== Docker pull/up =="
docker compose --env-file .env -f "$REMOTE_COMPOSE_FILE" pull zelo_ai
if docker ps --format '{{.Names}}' | grep -qx 'zelo-ai-ollama'; then
  echo "Existing Ollama container kept running; not pulling ollama/ollama:latest."
else
  docker compose --env-file .env -f "$REMOTE_COMPOSE_FILE" up -d ollama
fi
docker compose --env-file .env -f "$REMOTE_COMPOSE_FILE" up -d --no-deps zelo_ai

echo "== Wait for Ollama =="
for _ in $(seq 1 60); do
  if docker exec zelo-ai-ollama ollama list >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! docker exec zelo-ai-ollama ollama list >/dev/null 2>&1; then
  echo "ERROR: Ollama container is not ready."
  docker logs --tail=100 zelo-ai-ollama || true
  exit 1
fi

echo "== Ollama models =="
grep -E '^OLLAMA_(MODEL|PLANNER_MODEL|EMBEDDING_MODEL)=' .env \
  | cut -d= -f2- \
  | awk 'NF && !seen[$0]++' \
  | while IFS= read -r MODEL_NAME; do
      echo "Pulling $MODEL_NAME"
      docker exec zelo-ai-ollama ollama pull "$MODEL_NAME"
    done

echo "== Compose status =="
docker compose --env-file .env -f "$REMOTE_COMPOSE_FILE" ps

echo "Server deploy completed."
REMOTE_SCRIPT

echo ""
echo "== Public health check =="
curl -fsS "https://$AI_HOST/health"
echo ""
echo "Deploy completed."
