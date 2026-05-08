#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="${VERSION:-}"
if [ -z "$VERSION" ]; then
  echo "Missing VERSION."
  echo "Usage: VERSION=1.0.0 ./deploy/03-build-push-and-server-deploy.sh"
  exit 1
fi

DOCKER_IMAGE="${DOCKER_IMAGE:-hub.mintello.com/ai-zelo}"
SERVER_HOST="${SERVER_HOST:-195.15.215.113}"
SERVER_PORT="${SERVER_PORT:-5222}"
SERVER_USER="${SERVER_USER:-ubuntu}"
SERVER_REPO_DIR="${SERVER_REPO_DIR:-/home/ubuntu/Git/zelo_ai}"
SERVER_COMPOSE_FILE="${SERVER_COMPOSE_FILE:-deploy/docker-compose.with-ollama.yml}"
CACHE_ARCHIVE="${CACHE_ARCHIVE:-}"

if [ -z "$CACHE_ARCHIVE" ] && [ -f /tmp/zelo_ai_last_cache_archive.txt ]; then
  CACHE_ARCHIVE="$(cat /tmp/zelo_ai_last_cache_archive.txt)"
fi

if [ -z "$CACHE_ARCHIVE" ] || [ ! -f "$CACHE_ARCHIVE" ]; then
  echo "Missing CACHE_ARCHIVE."
  echo "Run ./deploy/01-local-preflight.sh first, or pass CACHE_ARCHIVE=/path/to/archive.tgz."
  exit 1
fi

ARCHIVE_BASENAME="$(basename "$CACHE_ARCHIVE")"

echo "== Zelo AI build + push + server deploy =="
echo "Docker image: $DOCKER_IMAGE:$VERSION"
echo "Server: $SERVER_USER@$SERVER_HOST:$SERVER_PORT"
echo "Server repo: $SERVER_REPO_DIR"
echo "Cache archive: $CACHE_ARCHIVE"
echo ""

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

echo "== Copy cache archive to server =="
scp -P "$SERVER_PORT" "$CACHE_ARCHIVE" "$SERVER_USER@$SERVER_HOST:~/$ARCHIVE_BASENAME"
echo ""

echo "== Deploy on server =="
ssh -p "$SERVER_PORT" "$SERVER_USER@$SERVER_HOST" \
  VERSION="$VERSION" \
  SERVER_REPO_DIR="$SERVER_REPO_DIR" \
  SERVER_COMPOSE_FILE="$SERVER_COMPOSE_FILE" \
  ARCHIVE_BASENAME="$ARCHIVE_BASENAME" \
  'bash -s' <<'REMOTE_SCRIPT'
set -euo pipefail

cd "$SERVER_REPO_DIR"
mkdir -p ~/zelo-ai-backups

echo "== Server git update =="
git fetch origin main
git status --short
git pull --ff-only origin main

echo "== Backup existing .env and .cache =="
STAMP="$(date +%Y%m%d_%H%M%S)"
if [ -f .env ]; then
  cp .env "$HOME/zelo-ai-backups/zelo_ai_env_before_$STAMP.env"
  echo "Backed up .env to ~/zelo-ai-backups/zelo_ai_env_before_$STAMP.env"
fi

if [ -d .cache ]; then
  tar -czf "$HOME/zelo-ai-backups/zelo_ai_cache_before_$STAMP.tgz" .cache
  echo "Backed up .cache to ~/zelo-ai-backups/zelo_ai_cache_before_$STAMP.tgz"
fi

echo "== Restore deploy .env =="
cp deploy/production.env.example .env
sed -i "s/^VERSION=.*/VERSION=$VERSION/" .env

echo "== Restore cache archive =="
tar -xzf "$HOME/$ARCHIVE_BASENAME"
find .cache -maxdepth 1 -type f -name "*.json" | sort
du -sh .cache

echo "== Docker pull/up =="
docker compose --env-file .env -f "$SERVER_COMPOSE_FILE" pull
docker compose --env-file .env -f "$SERVER_COMPOSE_FILE" up -d

echo "== Ollama models =="
docker exec zelo-ai-ollama ollama pull "$(grep "^OLLAMA_MODEL=" .env | cut -d= -f2-)"
docker exec zelo-ai-ollama ollama pull "$(grep "^OLLAMA_PLANNER_MODEL=" .env | cut -d= -f2-)"
docker exec zelo-ai-ollama ollama pull "$(grep "^OLLAMA_EMBEDDING_MODEL=" .env | cut -d= -f2-)"

echo "== Compose status =="
docker compose --env-file .env -f "$SERVER_COMPOSE_FILE" ps

echo "Server deploy completed."
REMOTE_SCRIPT

echo ""
echo "== Public health check =="
curl -fsS https://ai.zelo-epicerie.ch/health
echo ""
echo "Deploy completed."
