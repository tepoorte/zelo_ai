# Server Deploy Files

These files are isolated from the local development setup.

## Files

- `deploy.env`
- `deploy.env.example`
- `docker-compose.server.yml`
- `deploy-server.sh`
- `../Dockerfile.server`

## Default behavior

- If `OLLAMA_BASE_URL=http://ollama:11434`, `deploy-server.sh` starts:
  - `zelo_ai`
  - `ollama`

- If `OLLAMA_BASE_URL` points elsewhere, the script starts only:
  - `zelo_ai`

## Typical commands

```bash
cd deploy.server
chmod +x deploy-server.sh
./deploy-server.sh up
./deploy-server.sh logs
./deploy-server.sh ps
./deploy-server.sh down
```

## Current real-backend values already filled

```env
SWISSDATA_BASE_URL=https://api.zelo-epicerie.ch
SWISSDATA_API_KEY=PUBLICDEMO01
SWISSDATA_SHOP_ID=000000000000000000000001
```
