#!/usr/bin/env bash
set -euo pipefail

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
LOCAL_ENV_FILE="${LOCAL_ENV_FILE:-deploy/production.env.example}"
REMOTE_COMPOSE_FILE="${REMOTE_COMPOSE_FILE:-docker-compose.yml}"
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
  'bash -s' <<'REMOTE_MKDIR'
set -euo pipefail
mkdir -p "$SERVER_RUNTIME_DIR"
REMOTE_MKDIR
echo ""

echo "== Copy runtime files to server =="
scp -P "$SERVER_PORT" "$LOCAL_COMPOSE_FILE" "$SERVER_USER@$SERVER_HOST:$SERVER_RUNTIME_DIR/$REMOTE_COMPOSE_FILE"
scp -P "$SERVER_PORT" "$LOCAL_ENV_FILE" "$SERVER_USER@$SERVER_HOST:$SERVER_RUNTIME_DIR/.env.template"
scp -P "$SERVER_PORT" "$CACHE_ARCHIVE" "$SERVER_USER@$SERVER_HOST:$SERVER_RUNTIME_DIR/$ARCHIVE_BASENAME"
echo ""

echo "== Deploy runtime on server =="
ssh -p "$SERVER_PORT" "$SERVER_USER@$SERVER_HOST" \
  VERSION="$VERSION" \
  AI_HOST="$AI_HOST" \
  SERVER_RUNTIME_DIR="$SERVER_RUNTIME_DIR" \
  REMOTE_COMPOSE_FILE="$REMOTE_COMPOSE_FILE" \
  ARCHIVE_BASENAME="$ARCHIVE_BASENAME" \
  REPLACE_SERVER_CACHE="$REPLACE_SERVER_CACHE" \
  'bash -s' <<'REMOTE_SCRIPT'
set -euo pipefail

cd "$SERVER_RUNTIME_DIR"
BACKUP_DIR="$HOME/zelo-ai-backups"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d_%H%M%S)"

echo "== Backup existing runtime files =="
RESTORE_CACHE=1
if [ -f .env ]; then
  cp .env "$BACKUP_DIR/zelo_ai_env_before_$STAMP.env"
  echo "Backed up .env to $BACKUP_DIR/zelo_ai_env_before_$STAMP.env"
fi

if [ -f "$REMOTE_COMPOSE_FILE" ]; then
  cp "$REMOTE_COMPOSE_FILE" "$BACKUP_DIR/zelo_ai_compose_before_$STAMP.yml"
  echo "Backed up compose to $BACKUP_DIR/zelo_ai_compose_before_$STAMP.yml"
fi

if [ -d .cache ]; then
  tar -czf "$BACKUP_DIR/zelo_ai_cache_before_$STAMP.tgz" .cache
  echo "Backed up .cache to $BACKUP_DIR/zelo_ai_cache_before_$STAMP.tgz"

  if [ "$REPLACE_SERVER_CACHE" = "1" ]; then
    mv .cache "$BACKUP_DIR/zelo_ai_cache_dir_before_$STAMP"
    echo "Existing .cache moved to $BACKUP_DIR/zelo_ai_cache_dir_before_$STAMP"
  else
    RESTORE_CACHE=0
    echo "Existing server .cache kept active. Local cache archive will not replace it."
  fi
fi

echo "== Render .env =="
cp .env.template .env
sed -i "s/^VERSION=.*/VERSION=$VERSION/" .env
sed -i "s/^AI_HOST=.*/AI_HOST=$AI_HOST/" .env

echo "== Restore cache archive =="
if tar -tzf "$ARCHIVE_BASENAME" | grep -Eq '^\.cache/(tmp|whatsapp-web-session)(/|$)'; then
  echo "ERROR: cache archive contains .cache/tmp or .cache/whatsapp-web-session."
  echo "Re-run ./deploy/01-local-preflight.sh to create a clean cache archive."
  exit 1
fi

if [ "$RESTORE_CACHE" = "1" ]; then
  tar -xzf "$ARCHIVE_BASENAME"
else
  echo "Skipped cache restore because server .cache already exists."
fi
if [ ! -d .cache ]; then
  echo "ERROR: cache archive did not create .cache."
  exit 1
fi
find .cache -maxdepth 1 -type f -name "*.json" | sort
du -sh .cache

echo "== Validate compose =="
docker compose --env-file .env -f "$REMOTE_COMPOSE_FILE" config >/tmp/zelo_ai_compose_config.txt

echo "== Docker pull/up =="
docker compose --env-file .env -f "$REMOTE_COMPOSE_FILE" pull
docker compose --env-file .env -f "$REMOTE_COMPOSE_FILE" up -d

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
