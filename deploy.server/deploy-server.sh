#!/usr/bin/env sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.server.yml"
ENV_FILE="$SCRIPT_DIR/deploy.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE"
  echo "Copy deploy.env.example to deploy.env and fill values if needed."
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

ACTION="${1:-up}"
PROFILE_ARGS=""

if [ "${OLLAMA_BASE_URL:-}" = "http://ollama:11434" ]; then
  PROFILE_ARGS="--profile with-ollama"
fi

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" $PROFILE_ARGS "$@"
}

pull_models() {
  if [ "${OLLAMA_BASE_URL:-}" = "http://ollama:11434" ]; then
    echo "Pulling Ollama models inside server deployment..."
    docker exec zelo-ai-ollama ollama pull "${OLLAMA_MODEL:-llama3.2}"
    docker exec zelo-ai-ollama ollama pull "${OLLAMA_PLANNER_MODEL:-llama3.2:1b}"
    docker exec zelo-ai-ollama ollama pull "nomic-embed-text"
  fi
}

case "$ACTION" in
  up)
    compose up -d --build
    if [ "${OLLAMA_BASE_URL:-}" = "http://ollama:11434" ]; then
      sleep 3
      pull_models
    fi
    echo "Deploy started."
    echo "Target host: ${AI_HOST:-ai.zelo-epicerie.ch}"
    ;;
  down)
    compose down
    ;;
  restart)
    compose down
    compose up -d --build
    if [ "${OLLAMA_BASE_URL:-}" = "http://ollama:11434" ]; then
      sleep 3
      pull_models
    fi
    ;;
  logs)
    compose logs -f zelo_ai
    ;;
  logs-all)
    compose logs -f
    ;;
  ps)
    compose ps
    ;;
  pull-models)
    pull_models
    ;;
  *)
    echo "Usage: $0 {up|down|restart|logs|logs-all|ps|pull-models}"
    exit 1
    ;;
esac
