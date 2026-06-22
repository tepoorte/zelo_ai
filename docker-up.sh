#!/bin/sh

# Start local development container.
docker compose --env-file .env -f docker-compose-dev.yml up -d
